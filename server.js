const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// OpenAI setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Session storage (in production, use Redis or database)
const sessions = new Map();
const userSessions = new Map();

// Sage's counseling system prompts
const SAGE_SYSTEM_PROMPT = `You are Sage, an AI couples counselor trained in evidence-based therapy techniques. Your role is to facilitate healthy communication between partners using:

CORE TECHNIQUES:
- Gottman Method: Watch for Four Horsemen (criticism, contempt, defensiveness, stonewalling), promote love maps and emotional attunement
- CBT: Help identify thought patterns, cognitive reframing, behavioral interventions
- EFT: Focus on attachment styles and emotional cycles
- Active Listening: Encourage reflection and validation
- Solution-Focused: Build on strengths and establish goals

INTERVENTION TRIGGERS:
- Interrupt if conversation becomes heated or hostile
- Redirect when one person dominates (3+ consecutive messages)
- De-escalate criticism or blame language
- Pause for emotional check-ins during intensity
- Suggest breaks if needed

COMMUNICATION STYLE:
- Warm but professional
- Validate both perspectives
- Ask open-ended questions
- Offer specific techniques and tools
- Remind users you're an AI assistant, not replacement for professional therapy
- Keep responses concise but meaningful (2-3 sentences max unless giving techniques)

BOUNDARIES:
- Encourage professional therapy for serious issues (abuse, addiction, etc.)
- Don't give medical or psychiatric advice
- Focus on communication and relationship skills
- Maintain neutrality between partners

Respond as Sage would in a couples counseling session.`;

// Generate session code
function generateSessionCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// AI counselor response with context
async function getSageResponse(message, sessionId, conversationHistory) {
  try {
    const session = sessions.get(sessionId);
    if (!session) return "I'm having trouble accessing our session. Please try again.";

    // Build conversation context
    const recentMessages = conversationHistory.slice(-10); // Last 10 messages for context
    const contextMessages = [
      { role: "system", content: SAGE_SYSTEM_PROMPT },
      { role: "system", content: `Current session context: ${session.participants.length} participants, session duration: ${Math.floor((Date.now() - session.startTime) / 60000)} minutes` }
    ];

    // Add recent conversation history
    recentMessages.forEach(msg => {
      if (msg.sender !== 'sage' && msg.sender !== 'system') {
        contextMessages.push({
          role: "user",
          content: `${msg.senderName}: ${msg.content}`
        });
      }
    });

    // Add current message
    contextMessages.push({
      role: "user", 
      content: `${message.senderName}: ${message.content}`
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: contextMessages,
      max_tokens: 200,
      temperature: 0.7
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('OpenAI API Error:', error);
    return "I'm experiencing some technical difficulties. Let's continue our conversation, and I'll do my best to help you both communicate effectively.";
  }
}

// Check for intervention triggers
function checkInterventionTriggers(sessionId, newMessage) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  const recentMessages = session.messages.slice(-5);
  
  // Check for consecutive messages from same sender
  let consecutiveCount = 0;
  let lastSender = newMessage.sender;
  
  for (let i = recentMessages.length - 1; i >= 0; i--) {
    if (recentMessages[i].sender === lastSender && recentMessages[i].sender !== 'sage') {
      consecutiveCount++;
    } else {
      break;
    }
  }

  // Trigger intervention for 3+ consecutive messages
  if (consecutiveCount >= 2) {
    return {
      type: 'consecutive_messages',
      message: "I want to pause here for a moment. I notice one person has been sharing quite a bit. Let's make sure both voices are being heard. How are you feeling about what's been shared so far?"
    };
  }

  // Check for heated language (basic detection)
  const heatedWords = ['always', 'never', 'stupid', 'ridiculous', 'insane', 'crazy', 'hate'];
  const hasHeatedLanguage = heatedWords.some(word => 
    newMessage.content.toLowerCase().includes(word)
  );

  if (hasHeatedLanguage) {
    return {
      type: 'heated_language',
      message: "I'm sensing some strong emotions here. Let's take a breath and remember we're working toward understanding each other. Can you both share what you're feeling right now without judgment?"
    };
  }

  return null;
}

// Socket connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Create new session
  socket.on('create-session', (data) => {
    const sessionCode = generateSessionCode();
    const sessionId = sessionCode;
    
    const newSession = {
      id: sessionId,
      code: sessionCode,
      participants: [{
        id: socket.id,
        name: data.userName,
        joinedAt: new Date()
      }],
      messages: [],
      startTime: Date.now(),
      timer: 45 * 60 * 1000, // 45 minutes
      status: 'waiting'
    };

    sessions.set(sessionId, newSession);
    userSessions.set(socket.id, sessionId);
    
    socket.join(sessionId);
    
    socket.emit('session-created', {
      sessionCode,
      sessionId,
      userName: data.userName
    });

    // Sage's welcome message
    const welcomeMessage = {
      id: Date.now(),
      content: `Hello ${data.userName}! I'm Sage, your AI counseling assistant. I'm here to help facilitate healthy communication between you and your partner. Please wait for your partner to join using code: ${sessionCode}`,
      sender: 'sage',
      senderName: 'Sage',
      timestamp: new Date()
    };

    newSession.messages.push(welcomeMessage);
    socket.emit('message', welcomeMessage);
  });

  // Join existing session
  socket.on('join-session', (data) => {
    const session = sessions.get(data.sessionCode);
    
    if (!session) {
      socket.emit('error', { message: 'Session not found' });
      return;
    }

    if (session.participants.length >= 2) {
      socket.emit('error', { message: 'Session is full' });
      return;
    }

    // Add participant
    session.participants.push({
      id: socket.id,
      name: data.userName,
      joinedAt: new Date()
    });

    userSessions.set(socket.id, session.id);
    socket.join(session.id);

    // Send session data to new participant
    socket.emit('session-joined', {
      sessionCode: session.code,
      sessionId: session.id,
      userName: data.userName,
      messages: session.messages
    });

    // Notify ALL participants about updated count
    io.to(session.id).emit('participant-count-updated', {
      count: session.participants.length,
      participants: session.participants.map(p => p.name)
    });

    // Notify all participants
    const joinMessage = {
      id: Date.now(),
      content: `${data.userName} has joined the session.`,
      sender: 'system',
      senderName: 'System',
      timestamp: new Date()
    };

    session.messages.push(joinMessage);
    io.to(session.id).emit('message', joinMessage);

    // Sage's start message when both are present
    if (session.participants.length === 2) {
      session.status = 'active';
      
      setTimeout(() => {
        const startMessage = {
          id: Date.now() + 1,
          content: `Perfect! Both partners are now here. I'm ready to help facilitate your conversation. Remember, this is a safe space for open communication. What would you both like to focus on today?`,
          sender: 'sage',
          senderName: 'Sage',
          timestamp: new Date()
        };

        session.messages.push(startMessage);
        io.to(session.id).emit('message', startMessage);
      }, 1500);
    }
  });

  // Handle messages
  // In your server.js file, find the 'send-message' handler and replace it with this version:

// Replace your 'send-message' handler in server.js with this smarter version:

socket.on('send-message', async (data) => {
  const sessionId = userSessions.get(socket.id);
  const session = sessions.get(sessionId);

  if (!session) {
    socket.emit('error', { message: 'Session not found' });
    return;
  }

  const participant = session.participants.find(p => p.id === socket.id);
  if (!participant) {
    socket.emit('error', { message: 'Not authorized for this session' });
    return;
  }

  // Create message object
  const message = {
    id: Date.now(),
    content: data.content,
    sender: socket.id,
    senderName: participant.name,
    timestamp: new Date()
  };

  // Store message
  session.messages.push(message);

  // Broadcast to all participants
  io.to(sessionId).emit('message', message);

  // Initialize conversation tracking if not exists
  if (!session.conversationState) {
    session.conversationState = {
      messagesSinceLastSage: 0,
      lastSageTime: Date.now(),
      consecutiveFromSameUser: 0,
      lastSender: null
    };
  }

  const convState = session.conversationState;
  convState.messagesSinceLastSage++;

  // Track consecutive messages from same user
  if (convState.lastSender === message.sender) {
    convState.consecutiveFromSameUser++;
  } else {
    convState.consecutiveFromSameUser = 1;
    convState.lastSender = message.sender;
  }

  // Determine if Sage should respond
  let shouldSageRespond = false;
  let responseType = 'normal';

  // PRIORITY 1: Immediate intervention needed
  const intervention = checkInterventionTriggers(sessionId, message);
  if (intervention) {
    shouldSageRespond = true;
    responseType = 'intervention';
  }
  // PRIORITY 2: One person dominating (3+ consecutive messages)
  else if (convState.consecutiveFromSameUser >= 3) {
    shouldSageRespond = true;
    responseType = 'redirect';
  }
  // PRIORITY 3: Long silence from Sage (8+ messages without input)
  else if (convState.messagesSinceLastSage >= 8) {
    shouldSageRespond = true;
    responseType = 'checkin';
  }
  // PRIORITY 4: Heated language detected
  else if (detectHeatedLanguage(message.content)) {
    shouldSageRespond = true;
    responseType = 'deescalate';
  }
  // PRIORITY 5: Time-based check-in (5+ minutes of silence from Sage)
  else if (Date.now() - convState.lastSageTime > 5 * 60 * 1000) {
    shouldSageRespond = true;
    responseType = 'checkin';
  }
  // PRIORITY 6: Strategic guidance moments (after emotional sharing)
  else if (detectEmotionalContent(message.content) && convState.messagesSinceLastSage >= 3) {
    shouldSageRespond = true;
    responseType = 'support';
  }

  if (shouldSageRespond) {
    // Reset tracking
    convState.messagesSinceLastSage = 0;
    convState.lastSageTime = Date.now();
    convState.consecutiveFromSameUser = 0;

    if (responseType === 'intervention') {
      // Send intervention message
      setTimeout(() => {
        const interventionMessage = {
          id: Date.now(),
          content: intervention.message,
          sender: 'sage',
          senderName: 'Sage',
          timestamp: new Date(),
          type: 'interruption'
        };

        session.messages.push(interventionMessage);
        io.to(sessionId).emit('message', interventionMessage);
      }, 1000);
    } else {
      // Strategic Sage response
      setTimeout(async () => {
        const sageResponse = await getStrategicSageResponse(message, sessionId, session.messages, responseType);
        
        const responseMessage = {
          id: Date.now(),
          content: sageResponse,
          sender: 'sage',
          senderName: 'Sage',
          timestamp: new Date()
        };

        session.messages.push(responseMessage);
        io.to(sessionId).emit('message', responseMessage);
      }, 2000 + Math.random() * 2000); // 2-4 second delay
    }
  }
});

// Helper functions for detection
function detectHeatedLanguage(content) {
  const heatedWords = ['always', 'never', 'stupid', 'ridiculous', 'insane', 'crazy', 'hate', 'angry', 'furious', 'sick of'];
  return heatedWords.some(word => content.toLowerCase().includes(word));
}

function detectEmotionalContent(content) {
  const emotionalWords = ['feel', 'feeling', 'hurt', 'sad', 'upset', 'frustrated', 'worried', 'scared', 'love', 'miss'];
  return emotionalWords.some(word => content.toLowerCase().includes(word));
}

// Strategic response based on context
async function getStrategicSageResponse(message, sessionId, conversationHistory, responseType) {
  try {
    const session = sessions.get(sessionId);
    if (!session) return "I'm having trouble accessing our session.";

    let strategicPrompt = SAGE_SYSTEM_PROMPT;
    
    // Add response type specific guidance
    switch (responseType) {
      case 'redirect':
        strategicPrompt += "\n\nThe same person has been speaking for several messages. Gently redirect to give the other person space to share.";
        break;
      case 'checkin':
        strategicPrompt += "\n\nIt's been a while since you've spoken. Check in on how the conversation is going for both people.";
        break;
      case 'deescalate':
        strategicPrompt += "\n\nThere's some heated language. Help both people take a breath and communicate more calmly.";
        break;
      case 'support':
        strategicPrompt += "\n\nSomeone just shared something emotional. Provide supportive guidance that helps both partners understand each other.";
        break;
    }

    const recentMessages = conversationHistory.slice(-6);
    const contextMessages = [
      { role: "system", content: strategicPrompt },
      { role: "system", content: `Session context: ${session.participants.length} participants. Response type: ${responseType}` }
    ];

    recentMessages.forEach(msg => {
      if (msg.sender !== 'sage' && msg.sender !== 'system') {
        contextMessages.push({
          role: "user",
          content: `${msg.senderName}: ${msg.content}`
        });
      }
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: contextMessages,
      max_tokens: 150,
      temperature: 0.7
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('OpenAI API Error:', error);
    return "I'm experiencing some technical difficulties. Please continue your conversation - you're doing great at communicating with each other.";
  }
}

  // Handle typing indicators
  socket.on('typing', (data) => {
    const sessionId = userSessions.get(socket.id);
    const session = sessions.get(sessionId);
    
    if (session) {
      const participant = session.participants.find(p => p.id === socket.id);
      socket.to(sessionId).emit('user-typing', {
        userName: participant?.name,
        isTyping: data.isTyping
      });
    }
  });

  // Handle session controls
  socket.on('pause-session', () => {
    const sessionId = userSessions.get(socket.id);
    const session = sessions.get(sessionId);
    
    if (session) {
      session.paused = !session.paused;
      const statusMessage = {
        id: Date.now(),
        content: session.paused ? 'Session paused.' : 'Session resumed.',
        sender: 'sage',
        senderName: 'Sage',
        timestamp: new Date(),
        type: 'interruption'
      };
      
      session.messages.push(statusMessage);
      io.to(sessionId).emit('message', statusMessage);
    }
  });

  socket.on('end-session', () => {
    const sessionId = userSessions.get(socket.id);
    const session = sessions.get(sessionId);
    
    if (session) {
      const endMessage = {
        id: Date.now(),
        content: 'Session ended. Thank you both for your openness today. Your conversation has been a step toward better communication.',
        sender: 'sage',
        senderName: 'Sage',
        timestamp: new Date(),
        type: 'interruption'
      };
      
      session.messages.push(endMessage);
      io.to(sessionId).emit('message', endMessage);
      io.to(sessionId).emit('session-ended');
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    const sessionId = userSessions.get(socket.id);
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) {
        // Remove participant
        const disconnectedParticipant = session.participants.find(p => p.id === socket.id);
        session.participants = session.participants.filter(p => p.id !== socket.id);
        
        // Update participant count for remaining users
        if (session.participants.length > 0) {
          io.to(sessionId).emit('participant-count-updated', {
            count: session.participants.length,
            participants: session.participants.map(p => p.name)
          });
          
          const disconnectMessage = {
            id: Date.now(),
            content: `${disconnectedParticipant?.name || 'A participant'} has disconnected.`,
            sender: 'system',
            senderName: 'System',
            timestamp: new Date()
          };
          
          session.messages.push(disconnectMessage);
          socket.to(sessionId).emit('message', disconnectMessage);
        } else {
          // Clean up empty session
          sessions.delete(sessionId);
        }
      }
      
      userSessions.delete(socket.id);
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'Couples Counseling Server Running',
    activeSessions: sessions.size,
    timestamp: new Date()
  });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Couples Counseling Server running on port ${PORT}`);
  console.log(`💕 Sage AI Counselor ready to help couples communicate better`);
});


