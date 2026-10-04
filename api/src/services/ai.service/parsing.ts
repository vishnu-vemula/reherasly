import { getActivePrompt } from './prompts';
import groq from '../../config/groq';
import logger from '../../config/logger';
import { extractContextViaRAG, buildSemanticChunks, createAndStoreEmbeddings, retrieveContextForTopic } from '../rag.service';
import { optimizeQuery } from '../optimizer.service';
export const parseResumeAndJD = async (resumeText, jdText) => {
  const defaultPrompt = `You are an expert resume and job description parser.

Extract structured data in strict JSON format.

From Resume:
- name
- skills (array)
- experience (array of objects: role, company, duration, tech)
- projects (array: title, tech stack, description)
- education

From Job Description:
- role
- required_skills (array)
- preferred_skills (array)
- responsibilities (array)

Rules:
- Do not hallucinate
- If missing, return empty array or null
- Keep output strictly JSON`;

  const systemPrompt = await getActivePrompt('resume_parser', defaultPrompt);

  const userPrompt = `Input:
RESUME:
${resumeText || 'Not provided'}

JOB_DESCRIPTION:
${jdText || 'Not provided'}`;

  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 2048,
    response_format: { type: 'json_object' },
  }, { signal: AbortSignal.timeout(45_000), maxRetries: 1 });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('No response from AI parser.');

  try {
    return JSON.parse(content);
  } catch {
    throw new Error('AI parser returned invalid JSON.');
  }
};

/**
 * Generate specialized technical questions using RAG context
 * @param {Object} params
 * @param {string} params.retrievedChunks - Raw context from RAG
 * @param {Object} params.parsedResumeData - Structured resume JSON
 * @param {Object} params.parsedJdData - Structured job description JSON
 * @returns {Promise<string>} Numbered list of questions
 */

export const validateGrounding = async ({ retrievedChunks, modelOutput }) => {
  const systemPrompt = `You are a validation system.

Check whether the response is fully supported by the context.

Return JSON exactly as:
{
  "grounded": true|false,
  "unsupported_claims": [],
  "reason": ""
}`;

  const userPrompt = `Context:
${retrievedChunks}

Response:
${modelOutput}`;

  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.1,
    max_tokens: 1024,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content;
  try {
    return JSON.parse(content || '{}');
  } catch {
    throw new Error('AI validator returned invalid JSON.');
  }
};

/**
 * ── 6-STEP ORCHESTRATOR ──
 * Topic-based Dynamic Question Generator
 *
 * 1. Query Rewrite  (topic name -> technical goal string)
 * 2. Embed & Retrieve (Pinecone-like search on internal vectorStore)
 * 3. Retrieve top 5
 * 4. Format context
 * 5. Pass into Senior Technical Question Generator
 * 6. Generate questions
 */
