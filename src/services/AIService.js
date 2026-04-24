const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createModerationGraph } = require('./ModerationGraph');

/**
 * Universal AI Service supporting multiple AI providers
 * Supports: Gemini, LM Studio (LangGraph + OpenAI-compatible API), OpenAI-compatible APIs
 */
class AIService {
  constructor(config = null) {
    this.config = config;
    this._moderationGraph = null;

    this.providers = {
      gemini: new GeminiProvider(config),
      lmstudio: new LMStudioProvider(config),
      openai: new OpenAIProvider(config)
    };

    this.currentProvider = this._cfg('ai.provider') || 'gemini';
    const rawFb = this._cfg('ai.fallbackProviders');
    this.fallbackProviders = Array.isArray(rawFb)
      ? rawFb.map((s) => String(s).trim()).filter(Boolean)
      : String(rawFb || 'gemini,lmstudio')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    if (this.fallbackProviders.length === 0) {
      this.fallbackProviders = ['gemini', 'lmstudio'];
    }

    this._syncModerationSettings();

    const lg =
      this.currentProvider === 'lmstudio' && this._useLangGraph()
        ? ' (LangGraph + LM Studio)'
        : '';
    console.log(`🤖 AI Service initialized with provider: ${this.currentProvider}${lg}`);
  }

  _cfg(path, fallback = undefined) {
    if (this.config && typeof this.config.get === 'function') {
      const v = this.config.get(path);
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return fallback;
  }

  _syncModerationSettings() {
    const cat = this._cfg('moderation.categories') || {};
    this.moderationSettings = {
      strictness: this._cfg('moderation.strictness') || 'medium',
      categories: {
        toxicity: cat.toxicity !== false,
        harassment: cat.harassment !== false,
        hate_speech: cat.hateSpeech !== false,
        spam: cat.spam !== false,
        nsfw: cat.nsfw !== false,
        violence: cat.violence !== false
      },
      customRules: [],
      responseTemplates: {
        warning:
          this._cfg('moderation.responses.warning') ||
          '{author} ⚠️ Please keep the chat respectful. This is your warning.',
        timeout:
          this._cfg('moderation.responses.timeout') ||
          '{author} 🚫 Your message violated community guidelines. Timeout applied.',
        ban:
          this._cfg('moderation.responses.ban') ||
          '{author} ❌ You have been banned for repeated violations.'
      }
    };
  }

  _useLangGraph() {
    return this._cfg('ai.lmstudio.useLangGraph', true) !== false;
  }

  async _analyzeViaLangGraph(message, author, context) {
    if (!this.config || typeof this.config.get !== 'function') {
      throw new Error('Config required for LangGraph moderation');
    }
    if (!this._moderationGraph) {
      this._moderationGraph = createModerationGraph(this.config);
    }

    const graphContext = {
      ...context,
      isModerator: !!context.isModerator,
      isOwner: !!context.isOwner
    };

    const out = await this._moderationGraph.invoke({
      message,
      author,
      context: graphContext
    });

    const a = out.analysis;
    if (!a) {
      throw new Error('LangGraph returned no analysis');
    }

    const violationsRaw = Array.isArray(a.violations) ? a.violations : [];
    const violations = violationsRaw.map((v) =>
      typeof v === 'string'
        ? { type: v, severity: a.severity || 'medium' }
        : v
    );

    return {
      isViolation: !!a.isViolation,
      confidence:
        typeof a.confidence === 'number'
          ? a.confidence
          : Number(a.confidence) || 0.5,
      severity: a.severity || 'medium',
      violations,
      reasoning: a.reasoning || 'Moderation',
      method: a.method || 'langgraph-lmstudio'
    };
  }

  /**
   * Analyze message for offensive content
   */
  async analyzeMessage(message, author, context = {}) {
    const startTime = Date.now();
    
    try {
      // Try primary provider
      const result = await this._analyzeWithProvider(this.currentProvider, message, author, context);
      
      const responseTime = Date.now() - startTime;
      console.log(`✅ AI analysis completed in ${responseTime}ms using ${this.currentProvider}`);
      
      return {
        ...result,
        provider: this.currentProvider,
        responseTime,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.warn(`⚠️ Primary provider ${this.currentProvider} failed: ${error.message}`);
      
      // Try fallback providers
      for (const fallbackProvider of this.fallbackProviders) {
        if (fallbackProvider === this.currentProvider) continue;
        
        try {
          console.log(`🔄 Trying fallback provider: ${fallbackProvider}`);
          const result = await this._analyzeWithProvider(fallbackProvider, message, author, context);
          
          const responseTime = Date.now() - startTime;
          console.log(`✅ AI analysis completed in ${responseTime}ms using fallback ${fallbackProvider}`);
          
          return {
            ...result,
            provider: fallbackProvider,
            responseTime,
            timestamp: new Date().toISOString(),
            usedFallback: true
          };
        } catch (fallbackError) {
          console.warn(`⚠️ Fallback provider ${fallbackProvider} failed: ${fallbackError.message}`);
        }
      }
      
      // All providers failed - use rule-based analysis
      console.error('❌ All AI providers failed, using rule-based fallback');
      return this._ruleBasedAnalysis(message, author, context);
    }
  }

  /**
   * Analyze with specific provider
   */
  async _analyzeWithProvider(providerName, message, author, context) {
    if (providerName === 'lmstudio' && this._useLangGraph()) {
      try {
        return await this._analyzeViaLangGraph(message, author, context);
      } catch (e) {
        console.warn(
          `⚠️ LangGraph LM Studio failed (${e.message}); using direct LM Studio call`
        );
        const provider = this.providers.lmstudio;
        return await provider.analyze(
          message,
          author,
          context,
          this.moderationSettings
        );
      }
    }

    const provider = this.providers[providerName];
    if (!provider) {
      throw new Error(`Provider ${providerName} not found`);
    }

    return await provider.analyze(
      message,
      author,
      context,
      this.moderationSettings
    );
  }

  /**
   * Rule-based fallback analysis
   */
  _ruleBasedAnalysis(message, author, context) {
    const lowerMessage = message.toLowerCase();
    const violations = [];
    
    // Basic keyword detection
    const toxicKeywords = ['spam', 'scam', 'hate', 'kill', 'die', 'stupid', 'idiot'];
    const foundKeywords = toxicKeywords.filter(keyword => lowerMessage.includes(keyword));
    
    if (foundKeywords.length > 0) {
      violations.push({
        type: 'keyword_match',
        severity: 'medium',
        keywords: foundKeywords
      });
    }

    // Repeated characters (spam detection)
    if (/(.)\1{4,}/.test(message)) {
      violations.push({
        type: 'repeated_characters',
        severity: 'low'
      });
    }

    // All caps
    if (message.length > 10 && message === message.toUpperCase()) {
      violations.push({
        type: 'excessive_caps',
        severity: 'low'
      });
    }

    const isViolation = violations.length > 0;
    const maxSeverity = violations.length > 0 ? 
      Math.max(...violations.map(v => v.severity === 'high' ? 3 : v.severity === 'medium' ? 2 : 1)) : 0;

    return {
      isViolation,
      confidence: isViolation ? 0.7 : 0.1,
      severity: maxSeverity >= 3 ? 'high' : maxSeverity >= 2 ? 'medium' : 'low',
      violations,
      reasoning: `Rule-based analysis found ${violations.length} violations`,
      provider: 'rule-based-fallback',
      responseTime: 0,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Generate appropriate response based on analysis
   */
  generateResponse(analysis, author, violationHistory = {}) {
    if (!analysis.isViolation) {
      return null;
    }

    const userViolations = violationHistory[author] || 0;
    let responseType = 'warning';
    
    // Escalate based on violation history and severity
    if (analysis.severity === 'high' || userViolations >= 3) {
      responseType = 'ban';
    } else if (analysis.severity === 'medium' || userViolations >= 1) {
      responseType = 'timeout';
    }

    const template = this.moderationSettings.responseTemplates[responseType];
    return template.replace('{author}', author);
  }

  /**
   * Get service status
   */
  async getStatus() {
    const status = {
      currentProvider: this.currentProvider,
      providers: {},
      settings: this.moderationSettings
    };

    // Test each provider
    for (const [name, provider] of Object.entries(this.providers)) {
      try {
        status.providers[name] = await provider.getStatus();
      } catch (error) {
        status.providers[name] = {
          available: false,
          error: error.message
        };
      }
    }

    return status;
  }

  /**
   * Switch primary provider
   */
  switchProvider(providerName) {
    if (!this.providers[providerName]) {
      throw new Error(`Provider ${providerName} not available`);
    }
    
    this.currentProvider = providerName;
    console.log(`🔄 Switched to AI provider: ${providerName}`);
  }
}

/**
 * Google Gemini AI Provider
 */
class GeminiProvider {
  constructor(config) {
    this.config = config;
    this.apiKey =
      config && config.get && config.get('ai.gemini.apiKey')
        ? String(config.get('ai.gemini.apiKey'))
        : '';
    const modelName =
      (config && config.get && config.get('ai.gemini.model')) || 'gemini-2.0-flash';
    this.modelName = modelName;
    this.genAI = this.apiKey ? new GoogleGenerativeAI(this.apiKey) : null;
    this.model = this.genAI
      ? this.genAI.getGenerativeModel({ model: modelName })
      : null;
  }

  async analyze(message, author, context, settings) {
    if (!this.model) {
      throw new Error('Gemini API key not configured');
    }

    const prompt = this._buildPrompt(message, author, context, settings);
    
    const result = await this.model.generateContent(prompt);
    const response = await result.response;
    const text = await response.text();

    return this._parseResponse(text, message, author);
  }

  _buildPrompt(message, author, context, settings) {
    return `
Analyze this chat message for policy violations:

Message: "${message}"
Author: ${author}
Strictness: ${settings.strictness}

Check for: toxicity, harassment, hate speech, spam, NSFW content, violence.

Respond with JSON format:
{
  "isViolation": boolean,
  "confidence": number (0-1),
  "severity": "low|medium|high",
  "violations": ["category1", "category2"],
  "reasoning": "explanation"
}

Be precise and context-aware for livestream chat.`;
  }

  _parseResponse(text, message, author) {
    try {
      // Try to extract JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          isViolation: parsed.isViolation || false,
          confidence: parsed.confidence || 0,
          severity: parsed.severity || 'low',
          violations: parsed.violations || [],
          reasoning: parsed.reasoning || text
        };
      }
    } catch (error) {
      console.warn('Failed to parse Gemini JSON response, using text analysis');
    }

    // Fallback to text analysis
    const isViolation = text.toLowerCase().includes('true') || 
                       text.toLowerCase().includes('violation') ||
                       text.toLowerCase().includes('offensive');
    
    return {
      isViolation,
      confidence: isViolation ? 0.8 : 0.2,
      severity: 'medium',
      violations: [],
      reasoning: text
    };
  }

  async getStatus() {
    if (!this.apiKey) {
      return { available: false, error: 'API key not configured' };
    }

    try {
      // Test API with simple request
      const result = await this.model.generateContent('Test connection');
      await result.response;
      
      return { 
        available: true, 
        model: this.modelName,
        rateLimits: 'Standard Google AI limits'
      };
    } catch (error) {
      return { 
        available: false, 
        error: error.message 
      };
    }
  }
}

/**
 * LMStudio Local AI Provider
 */
class LMStudioProvider {
  constructor(config) {
    this.config = config;
  }

  _baseUrl() {
    const raw =
      (this.config && this.config.get && this.config.get('ai.lmstudio.url')) ||
      'http://localhost:1234';
    return String(raw).replace(/\/$/, '');
  }

  _model() {
    return (
      (this.config && this.config.get && this.config.get('ai.lmstudio.model')) ||
      'local-model'
    );
  }

  _timeout() {
    const t =
      (this.config && this.config.get && this.config.get('ai.lmstudio.timeout')) ||
      12000;
    return Number(t) || 12000;
  }

  async analyze(message, author, context, settings) {
    const prompt = this._buildPrompt(message, author, context, settings);

    const response = await axios.post(
      `${this._baseUrl()}/v1/chat/completions`,
      {
        model: this._model(),
        messages: [
          {
            role: 'system',
            content:
              'You are a chat moderation AI. Analyze messages for policy violations and respond with precise JSON only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
        max_tokens: 200
      },
      { timeout: this._timeout(), headers: { 'Content-Type': 'application/json' } }
    );

    const text = response.data.choices[0].message.content;
    return this._parseResponse(text, message, author);
  }

  _buildPrompt(message, author, context, settings) {
    return `Analyze this livestream chat message:

Message: "${message}"
Author: ${author}
Strictness: ${settings.strictness}

Check for violations: toxicity, harassment, hate speech, spam, NSFW, violence.

Respond ONLY with valid JSON:
{
  "isViolation": boolean,
  "confidence": number,
  "severity": "low|medium|high", 
  "violations": ["category"],
  "reasoning": "brief explanation"
}`;
  }

  _parseResponse(text, message, author) {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          isViolation: parsed.isViolation || false,
          confidence: Math.min(parsed.confidence || 0, 1),
          severity: parsed.severity || 'low',
          violations: parsed.violations || [],
          reasoning: parsed.reasoning || 'LMStudio analysis'
        };
      }
    } catch (error) {
      console.warn('Failed to parse LMStudio JSON response');
    }

    // Fallback analysis
    const isViolation = text.toLowerCase().includes('violation') || 
                       text.toLowerCase().includes('offensive') ||
                       text.toLowerCase().includes('inappropriate');
    
    return {
      isViolation,
      confidence: 0.6,
      severity: 'medium',
      violations: [],
      reasoning: text.substring(0, 100)
    };
  }

  async getStatus() {
    const baseUrl = this._baseUrl();
    try {
      const response = await axios.get(`${baseUrl}/v1/models`, {
        timeout: 5000
      });

      const models = response.data.data || [];
      return {
        available: true,
        url: baseUrl,
        models: models.map((m) => m.id),
        currentModel: this._model()
      };
    } catch (error) {
      return {
        available: false,
        error: `LMStudio not accessible at ${baseUrl}: ${error.message}`
      };
    }
  }
}

/**
 * OpenAI-Compatible Provider (for other local models)
 */
class OpenAIProvider {
  constructor(config) {
    this.config = config;
    this.apiKey =
      config && config.get && config.get('ai.openai.apiKey')
        ? String(config.get('ai.openai.apiKey'))
        : '';
    this.baseUrl =
      (config && config.get && config.get('ai.openai.baseUrl')) ||
      'https://api.openai.com/v1';
    this.model =
      (config && config.get && config.get('ai.openai.model')) || 'gpt-3.5-turbo';
  }

  async analyze(message, author, context, settings) {
    if (!this.apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    const prompt = this._buildPrompt(message, author, context, settings);
    
    const response = await axios.post(`${this.baseUrl}/chat/completions`, {
      model: this.model,
      messages: [
        {
          role: "system",
          content: "You are a professional chat moderation AI for live streams."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.1,
      max_tokens: 150
    }, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    const text = response.data.choices[0].message.content;
    return this._parseResponse(text, message, author);
  }

  _buildPrompt(message, author, context, settings) {
    return `Moderate this chat message for a live stream:

Message: "${message}"
From: ${author}
Moderation level: ${settings.strictness}

Analyze for: harassment, hate speech, spam, inappropriate content.

Return JSON only:
{
  "isViolation": boolean,
  "confidence": 0-1,
  "severity": "low|medium|high",
  "violations": ["type"],
  "reasoning": "explanation"
}`;
  }

  _parseResponse(text, message, author) {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          isViolation: parsed.isViolation || false,
          confidence: parsed.confidence || 0,
          severity: parsed.severity || 'low',
          violations: parsed.violations || [],
          reasoning: parsed.reasoning || text
        };
      }
    } catch (error) {
      console.warn('Failed to parse OpenAI JSON response');
    }

    const isViolation = text.toLowerCase().includes('violation') || 
                       text.toLowerCase().includes('inappropriate');
    
    return {
      isViolation,
      confidence: 0.7,
      severity: 'medium', 
      violations: [],
      reasoning: text.substring(0, 100)
    };
  }

  async getStatus() {
    if (!this.apiKey) {
      return { available: false, error: 'API key not configured' };
    }

    try {
      const response = await axios.get(`${this.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: 5000
      });
      
      return {
        available: true,
        model: this.model,
        baseUrl: this.baseUrl
      };
    } catch (error) {
      return {
        available: false,
        error: error.message
      };
    }
  }
}

module.exports = AIService;