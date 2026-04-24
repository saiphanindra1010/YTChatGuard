'use strict';

const { StateGraph, START, END, Annotation } = require('@langchain/langgraph');
const { ChatOpenAI } = require('@langchain/openai');
const { SystemMessage, HumanMessage } = require('@langchain/core/messages');

const CRITICAL_PATTERNS = [
  /\b(kill\s+yourself|kys|suicide|hang\s+yourself)\b/i,
  /\b(terrorist|bomb|kill\s+everyone|shoot\s+up)\b/i,
  /\b(rape|molest|child\s+abuse)\b/i
];

function clamp01(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

function parseJsonFromLlm(text) {
  const raw = typeof text === 'string' ? text : JSON.stringify(text);
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      return {
        isViolation: !!parsed.isViolation,
        confidence: clamp01(Number(parsed.confidence)),
        severity: ['low', 'medium', 'high'].includes(parsed.severity)
          ? parsed.severity
          : 'medium',
        violations: Array.isArray(parsed.violations) ? parsed.violations : [],
        reasoning: String(parsed.reasoning || '').slice(0, 500) || 'Model output'
      };
    }
  } catch {
    /* fall through */
  }
  const low = raw.toLowerCase();
  const bad =
    low.includes('"isviolation": true') ||
    low.includes('"isViolation": true') ||
    (low.includes('violation') && low.includes('true'));
  return {
    isViolation: bad,
    confidence: bad ? 0.65 : 0.4,
    severity: 'medium',
    violations: [],
    reasoning: raw.slice(0, 200)
  };
}

/**
 * Fast rule gate: allow LM bypass for obvious safe / critical unsafe text.
 */
function ruleGateNode(state) {
  const msg = state.message || '';
  const text = msg.toLowerCase();
  const ctx = state.context || {};

  if (ctx.isOwner || ctx.isModerator) {
    return {
      route: 'allow',
      analysis: {
        isViolation: false,
        confidence: 1,
        severity: 'low',
        violations: [],
        reasoning: 'Channel staff — skipped model',
        method: 'langgraph-rules'
      }
    };
  }

  for (const re of CRITICAL_PATTERNS) {
    if (re.test(text)) {
      return {
        route: 'block',
        analysis: {
          isViolation: true,
          confidence: 0.95,
          severity: 'high',
          violations: ['critical'],
          reasoning: 'Blocked by safety rules',
          method: 'langgraph-rules'
        }
      };
    }
  }

  const trimmed = text.trim();
  if (
    trimmed.length <= 8 &&
    /^(hi|hey|yo|lol|gg|wp|ok|thx|ty|thanks|pog)$/i.test(trimmed)
  ) {
    return {
      route: 'allow',
      analysis: {
        isViolation: false,
        confidence: 0.92,
        severity: 'low',
        violations: [],
        reasoning: 'Short benign message',
        method: 'langgraph-rules'
      }
    };
  }

  return { route: 'llm', analysis: undefined };
}

/**
 * Build compiled LangGraph: rule_gate → (END | LM Studio).
 * ChatOpenAI is pointed at LM Studio’s OpenAI-compatible /v1 endpoint.
 */
function createModerationGraph(config) {
  const baseUrl = String(
    config.get('ai.lmstudio.url') || 'http://localhost:1234'
  ).replace(/\/$/, '');
  const modelName = config.get('ai.lmstudio.model') || 'local-model';
  const timeout = Number(config.get('ai.lmstudio.timeout')) || 12000;
  const maxTokens = Number(config.get('ai.lmstudio.maxTokens')) || 180;
  const strictness = config.get('moderation.strictness') || 'medium';

  const chat = new ChatOpenAI({
    model: modelName,
    temperature: 0,
    maxTokens,
    timeout,
    configuration: {
      baseURL: `${baseUrl}/v1`,
      apiKey: 'lm-studio'
    }
  });

  const lmModerate = async (state) => {
    const sys = `You are a fast livestream chat moderator. Strictness: ${strictness}.
Reply with ONLY one JSON object (no markdown fences):
{"isViolation":boolean,"confidence":number,"severity":"low"|"medium"|"high","violations":string[],"reasoning":string}
Categories: toxicity, harassment, hate, spam, slurs, sexual content, violence, self-harm. Be concise.`;

    const res = await chat.invoke([
      new SystemMessage(sys),
      new HumanMessage(
        `Author: ${state.author || 'unknown'}\nMessage: ${state.message || ''}`
      )
    ]);

    const text =
      typeof res.content === 'string'
        ? res.content
        : Array.isArray(res.content)
          ? res.content.map((c) => c.text || '').join('')
          : String(res.content);

    const parsed = parseJsonFromLlm(text);
    return {
      analysis: {
        ...parsed,
        method: 'langgraph-lmstudio'
      }
    };
  };

  const ModerationState = Annotation.Root({
    message: Annotation(),
    author: Annotation(),
    context: Annotation(),
    route: Annotation(),
    analysis: Annotation()
  });

  return new StateGraph(ModerationState)
    .addNode('rule_gate', ruleGateNode)
    .addNode('lm_moderate', lmModerate)
    .addConditionalEdges(
      'rule_gate',
      (s) => {
        if (s.route === 'block' || s.route === 'allow') return s.route;
        return 'llm';
      },
      { block: END, allow: END, llm: 'lm_moderate' }
    )
    .addEdge('lm_moderate', END)
    .addEdge(START, 'rule_gate')
    .compile();
}

module.exports = { createModerationGraph };
