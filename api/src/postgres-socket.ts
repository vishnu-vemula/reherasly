import { Server } from 'socket.io';
import Groq from 'groq-sdk';
import prisma from './config/prisma';
import { resolvePostgresUser } from './services/postgres-identity.service';

export default function initPostgresSocket(httpServer: any) {
  const allowedOrigin = new URL(process.env.CLIENT_URL || 'http://localhost:5173').origin;
  const io = new Server(httpServer, { cors: {
    origin: allowedOrigin, methods: ['GET', 'POST'],
  },
  // Engine.IO CORS applies to polling, but WebSocket upgrades also need an
  // explicit Origin check. Non-browser clients without Origin still use auth.
  allowRequest: (request, callback) => {
    const origin = request.headers.origin;
    callback(null, !origin || origin === allowedOrigin);
  } });
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string') throw new Error('Authentication required');
      const { user } = await resolvePostgresUser(token);
      socket.data.userId = user.id;
      socket.data.token = token;
      next();
    } catch { next(new Error('Authentication required')); }
  });
  io.on('connection', socket => {
    socket.on('live_answer', async (payload: any) => {
      let claimedAnswerId = '';
      try {
        const { user } = await resolvePostgresUser(socket.data.token);
        if (user.id !== socket.data.userId) throw new Error('Authentication required');
        if (socket.data.liveBusy) throw new Error('A follow-up is already running');
        socket.data.liveBusy = true;
        const sessionId = String(payload?.sessionId || '');
        const interviewId = String(payload?.interviewId || '');
        const questionId = String(payload?.questionId || '');
        const answerText = String(payload?.answerText || '').trim();
        if (!answerText || answerText.length > 4000) throw new Error('Invalid answer');
        const interview = await prisma.interview.findFirst({ where: { id: interviewId, userId: socket.data.userId },
          include: { questions: { where: { id: questionId } } } });
        const question = interview?.questions[0];
        if (!question) throw new Error('Interview access denied');
        const answer = await prisma.answer.findFirst({ where: { sessionId, questionId,
          session: { userId: socket.data.userId, interviewId, status: { in: ['started', 'in_progress'] } },
          text: answerText, skipped: false, followupUsed: false } });
        if (!answer) throw new Error('Save this answer before requesting its one live follow-up');
        const claimed = await prisma.answer.updateMany({ where: { id: answer.id, followupUsed: false,
          text: answerText, skipped: false,
          session: { userId: socket.data.userId, interviewId, status: { in: ['started', 'in_progress'] } } },
          data: { followupUsed: true } });
        if (!claimed.count) throw new Error('Follow-up already used');
        claimedAnswerId = answer.id;
        const configured = await prisma.systemPrompt.findUnique({ where: { category: 'interview' } });
        const instruction = configured?.content || 'Act as an AI interviewer. Provide a brief 1-3 sentence follow-up based on the answer.';
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const stream = await groq.chat.completions.create({ model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'system', content: instruction }, { role: 'user', content:
            `Question: ${question.prompt}\nExpected keywords: ${question.expectedKeywords.join(', ') || 'None'}\nCandidate answer: ${answerText}` }],
          temperature: 0.5, max_tokens: 150, stream: true,
        }, { signal: AbortSignal.timeout(45_000), maxRetries: 1 });
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          if (content) socket.emit('ai_chunk', content);
        }
        socket.emit('ai_complete');
      } catch {
        if (claimedAnswerId) await prisma.answer.updateMany({ where: { id: claimedAnswerId,
          text: String(payload?.answerText || '').trim(), followupUsed: true,
          session: { userId: socket.data.userId, status: { in: ['started', 'in_progress'] } } },
          data: { followupUsed: false } }).catch(() => {});
        socket.emit('ai_error', 'Live feedback is unavailable or has already been used for this answer.');
      } finally { socket.data.liveBusy = false; }
    });
  });
  return io;
}
