const EventEmitter = require('events');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { AIWorkerPool } = require('./AIWorkerPool');

const MAX_ACTION_LOG = 2500;
const MAX_LIVE_COMMENTS = 1000;
const STATS_EMIT_INTERVAL_MS = 750;

/**
 * Professional Chat Monitor - Intelligent Content Moderation
 * Records EVERY message + Uses AI intelligently for optimal speed/accuracy balance
 */
class ChatMonitor extends EventEmitter {
  constructor(youtubeService, aiService, config) {
    super();
    
    this.youtubeService = youtubeService;
    this.aiService = aiService;
    this.config = config;
    
    // State management
    this.isRunning = false;
    this.liveChatId = null;
    this.currentVideoId = null;
    this.nextPageToken = null;
    this._pollTimer = null;
    this._saveIntervalId = null;
    this._statsEmitTimer = null;
    this._processorTimer = null;
    this._pollInFlight = false;
    this._lastPollDelayMs = 0;
    this._lastStatsHash = '';

    // Smart processing system
    this.messageDatabase = []; // Records EVERYTHING
    this.analysisDatabase = [];
    this.actionLog = []; // Structured moderation actions (warn / timeout / ban-tier chat posts)
    this.liveCommentLog = []; // Bounded ring buffer for SSE replay on (re)connect
    this.smartCache = new Map(); // Intelligent caching
    this.userProfiles = new Map(); // User behavior tracking

    // Smart queues - different priorities
    this.fastQueue = []; // Rule-based processing (synchronous, drained on poll)
    this.aiPool = null;  // Bounded AI worker pool, created on start()
    this.processingActive = false;
    
    // Storage
    this.storageDir =
      process.env.SAFESTREAM_DATA_DIR ||
      process.env.YTCHATGUARD_DATA_DIR ||
      path.join(process.cwd(), 'data');
    this.messagesFile = path.join(this.storageDir, 'smart-messages.json');
    this.analysisFile = path.join(this.storageDir, 'smart-analysis.json');
    this.actionsFile = path.join(this.storageDir, 'moderation-actions.json');
    
    // Smart rules for AI decisions
    this.smartRules = this._initializeSmartRules();
    
    // Performance stats
    this.stats = {
      totalMessages: 0,
      fastProcessed: 0,
      aiProcessed: 0,
      cacheHits: 0,
      violationsFound: 0,
      averageProcessingTime: 0,
      sessionStart: null,
      smartDecisions: {
        immediateAllow: 0,
        immediateBlock: 0,
        needsAI: 0,
        cacheUsed: 0
      }
    };
    
    console.log('Smart Balanced Monitor initialized - records everything, uses AI intelligently');
  }

  /**
   * Start smart balanced monitoring
   */
  async start(options = {}) {
    if (this.isRunning) {
      throw new Error('Smart monitor already running');
    }

    try {
      console.log('Starting SMART BALANCED monitoring...');
      console.log('Will record EVERY message');
      console.log('Will use AI intelligently (not on everything)');
      
      await this._ensureStorageDir();
      await this._loadExistingData();

      const rawVideo = options.videoId;
      const videoId =
        rawVideo && String(rawVideo).trim() ? String(rawVideo).trim() : null;

      if (videoId) {
        this.currentVideoId = videoId;
        this.liveChatId = await this.youtubeService.findLiveChatForVideo(videoId);
        if (!this.liveChatId) {
          throw new Error(
            'No live chat for that video. Use your active stream URL while live, or leave blank to use your current live broadcast.'
          );
        }
      } else {
        this.currentVideoId = null;
        this.liveChatId = await this.youtubeService.findActiveChat();
        if (!this.liveChatId) {
          throw new Error(
            'No active live broadcast found. Go live on your channel, or paste a live video URL / ID.'
          );
        }
      }

      this.isRunning = true;
      this.stats.sessionStart = new Date();

      const concurrency = Math.max(
        1,
        Number(this.config.get('ai.concurrency')) || 4
      );
      const queueDepth = Math.max(
        10,
        Number(this.config.get('ai.queueMaxDepth')) || 200
      );
      this.aiPool = new AIWorkerPool({
        concurrency,
        maxQueueDepth: queueDepth,
        handler: (item) => this._processAIItem(item)
      });

      this._scheduleNextPoll(0);
      this._startSmartProcessor();

      this._saveIntervalId = setInterval(() => {
        if (this.isRunning) this._saveData();
      }, 30000);

      this._statsEmitTimer = setInterval(() => {
        if (!this.isRunning) return;
        this._emitStatsIfChanged();
      }, STATS_EMIT_INTERVAL_MS);

      console.log(`Smart monitoring started - balanced speed + AI accuracy`);
      
      this.emit('started', { 
        liveChatId: this.liveChatId, 
        mode: 'smart-balanced' 
      });
      
      return { 
        success: true, 
        liveChatId: this.liveChatId,
        videoId: this.currentVideoId,
        mode: 'smart-balanced',
        message: 'Recording everything + using AI smartly'
      };

    } catch (error) {
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop monitoring and save data
   */
  async stop() {
    if (!this.isRunning) return false;

    console.log('Stopping smart monitoring...');

    this.isRunning = false;

    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._saveIntervalId) {
      clearInterval(this._saveIntervalId);
      this._saveIntervalId = null;
    }
    if (this._statsEmitTimer) {
      clearInterval(this._statsEmitTimer);
      this._statsEmitTimer = null;
    }
    if (this._processorTimer) {
      clearTimeout(this._processorTimer);
      this._processorTimer = null;
    }

    // Process remaining messages
    await this._processRemainingQueues();
    
    // Save all data
    await this._saveData();

    const report = this._generateSmartReport();
    console.log('Smart session completed:', report.summary);
    
    this.emit('stopped', report);
    return report;
  }

  /**
   * Schedule the next adaptive poll. Honors YouTube's `pollingIntervalMillis`
   * hint, clamped to [pollMin, pollMax] from config.
   */
  _scheduleNextPoll(delayMs) {
    if (!this.isRunning) return;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    const min = Math.max(250, Number(this.config.get('smart.pollIntervalMin')) || 500);
    const max = Math.max(min, Number(this.config.get('smart.pollIntervalMax')) || 3000);
    const delay = Math.min(max, Math.max(0, delayMs == null ? min : delayMs));
    this._lastPollDelayMs = delay;
    this._pollTimer = setTimeout(() => {
      this._smartPollMessages().catch((error) => {
        console.error('Smart polling error:', error.message);
        this.emit('error', error);
        this._scheduleNextPoll(min);
      });
    }, delay);
  }

  /**
   * Adaptive message polling — records everything and self-reschedules.
   *
   * Why this is fast:
   *  - `setTimeout` chain (not setInterval) avoids tick-stacking when a poll
   *    runs long.
   *  - Honors YouTube's `pollingIntervalMillis` (typically 500–1500 ms during
   *    active chat) instead of a fixed 2.5 s floor.
   *  - In-flight guard prevents overlap on a slow request.
   *  - Each message emits a `comment` event immediately so the dashboard sees
   *    it before classification finishes.
   */
  async _smartPollMessages() {
    if (!this.isRunning) return;
    if (this._pollInFlight) {
      this._scheduleNextPoll(this._lastPollDelayMs || 500);
      return;
    }
    this._pollInFlight = true;

    let nextDelay = Number(this.config.get('smart.pollIntervalMin')) || 500;

    try {
      const response = await this.youtubeService.getChatMessages(
        this.liveChatId,
        this.nextPageToken
      );

      if (response?.pollingIntervalMillis != null) {
        nextDelay = Number(response.pollingIntervalMillis) || nextDelay;
      }

      const messages = response?.items || [];
      if (response?.nextPageToken) this.nextPageToken = response.nextPageToken;

      for (const rawMessage of messages) {
        const messageData = this._extractMessageData(rawMessage);

        this.messageDatabase.push(messageData);
        this.stats.totalMessages++;

        this._updateUserProfile(messageData);
        this._recordLiveComment(messageData);

        this.emit('comment', messageData);

        const decision = this._makeSmartDecision(messageData);

        if (decision.action === 'fast') {
          this.fastQueue.push({ message: messageData, decision });
          this.stats.smartDecisions.immediateAllow++;
        } else if (decision.action === 'block') {
          this.fastQueue.push({ message: messageData, decision });
          this.stats.smartDecisions.immediateBlock++;
        } else if (decision.action === 'ai') {
          const accepted = this.aiPool && this.aiPool.submit(
            { message: messageData, decision },
            this._priorityScore(decision.priority)
          );
          if (!accepted) {
            // Backpressure: pool full → degrade to rules-only verdict
            this.fastQueue.push({
              message: messageData,
              decision: { ...decision, action: 'fast', reason: 'queue_shed' }
            });
          }
          this.stats.smartDecisions.needsAI++;
        } else if (decision.action === 'cached') {
          this._handleCachedResult(messageData, decision.cachedResult);
          this.stats.smartDecisions.cacheUsed++;
        }
      }

      if (messages.length > 0) {
        console.log(
          `Recorded ${messages.length} | Fast: ${this.fastQueue.length} | AI inflight: ${this.aiPool?.inflightCount() || 0} queued: ${this.aiPool?.size() || 0}`
        );
      }
    } catch (error) {
      if (error.code === 404) {
        console.log('Live chat ended');
        this._pollInFlight = false;
        await this.stop();
        return;
      }
      console.error('Smart polling error:', error.message);
    } finally {
      this._pollInFlight = false;
      this._scheduleNextPoll(nextDelay);
    }
  }

  /**
   * Lower number = higher priority (runs first).
   */
  _priorityScore(label) {
    switch (label) {
      case 'high': return 0;
      case 'medium': return 5;
      case 'low': return 10;
      default: return 7;
    }
  }

  /**
   * Maintain a bounded ring of recent comments for SSE replay.
   */
  _recordLiveComment(messageData) {
    this.liveCommentLog.push({
      id: messageData.id,
      author: messageData.author,
      authorId: messageData.authorId,
      message: messageData.message,
      timestamp: messageData.timestamp,
      isModerator: messageData.isModerator,
      isOwner: messageData.isOwner,
      isSponsored: messageData.isSponsored
    });
    if (this.liveCommentLog.length > MAX_LIVE_COMMENTS) {
      this.liveCommentLog.splice(0, this.liveCommentLog.length - MAX_LIVE_COMMENTS);
    }
  }

  getRecentComments(limit = 200) {
    const lim = Math.min(MAX_LIVE_COMMENTS, Math.max(1, Number(limit) || 200));
    return this.liveCommentLog.slice(-lim);
  }

  /**
   * Emit a `stats` event when the snapshot meaningfully changes.
   * Cheap signature avoids spamming subscribers when nothing moved.
   */
  _emitStatsIfChanged() {
    const stats = this.getSmartStats();
    const sig = `${stats.totalMessages}|${stats.flaggedMessages}|${stats.aiProcessed}|${stats.cached}|${stats.processing.fastQueue}|${stats.processing.aiQueue}`;
    if (sig === this._lastStatsHash) return;
    this._lastStatsHash = sig;
    this.emit('stats', stats);
  }

  /**
   * Smart decision engine - determines how to process each message
   */
  _makeSmartDecision(message) {
    const text = message.message.toLowerCase();
    const author = message.author.toLowerCase();
    
    // 1. IMMEDIATE ALLOW (fastest path)
    if (this._shouldImmediatelyAllow(message, text)) {
      return { action: 'fast', reason: 'immediate_allow', processing: 'rule-based' };
    }
    
    // 2. CHECK SMART CACHE (very fast)
    const cacheKey = this._generateSmartCacheKey(message.message);
    if (this.smartCache.has(cacheKey)) {
      const cached = this.smartCache.get(cacheKey);
      // Use cache if recent and reliable
      if (Date.now() - cached.timestamp < 300000 && cached.confidence > 0.8) { // 5 minutes
        return { action: 'cached', cachedResult: cached, reason: 'cache_hit' };
      }
    }
    
    // 3. IMMEDIATE BLOCK (fast rules)
    const blockCheck = this._checkImmediateBlock(text, message);
    if (blockCheck.shouldBlock) {
      return { action: 'block', reason: blockCheck.reason, processing: 'rule-based' };
    }

    if (this.config.get('moderation.enabled') === false) {
      return { action: 'fast', reason: 'moderation_disabled', processing: 'none' };
    }
    
    // 4. SMART AI ROUTING - only when needed
    const aiPriority = this._calculateAIPriority(message, text);
    
    if (aiPriority >= 0.7) {
      return { action: 'ai', priority: 'high', reason: 'high_risk_content' };
    } else if (aiPriority >= 0.4) {
      return { action: 'ai', priority: 'medium', reason: 'uncertain_content' };
    } else if (aiPriority >= 0.2) {
      return { action: 'ai', priority: 'low', reason: 'safety_check' };
    } else {
      return { action: 'fast', reason: 'low_risk', processing: 'rule-based' };
    }
  }

  /**
   * Should immediately allow (owners, mods, clean messages)
   */
  _shouldImmediatelyAllow(message, text) {
    // Owner/Moderator bypass
    if (message.isOwner || message.isModerator) return true;
    
    // Whitelist users
    const whitelist = this.config.get('moderation.whitelist.users') || [];
    if (whitelist.some(user => message.author.toLowerCase().includes(user.toLowerCase()))) {
      return true;
    }
    
    // Very short positive messages
    if (text.length <= 5 && /^(hi|hey|lol|wow|yes|no|ok|thx|ty)$/.test(text)) {
      return true;
    }
    
    // Obvious positive messages
    const positiveWords = ['thanks', 'thank you', 'love', 'great', 'awesome', 'good job', 'amazing'];
    if (positiveWords.some(word => text.includes(word)) && text.length < 50) {
      return true;
    }
    
    return false;
  }

  /**
   * Check for immediate blocking (critical violations)
   */
  _checkImmediateBlock(text, message) {
    // Critical threats
    if (this.smartRules.critical.some(pattern => pattern.test(text))) {
      return { shouldBlock: true, reason: 'critical_violation', severity: 'high' };
    }
    
    // Obvious spam
    if (this._isObviousSpam(text, message)) {
      return { shouldBlock: true, reason: 'spam_detected', severity: 'medium' };
    }
    
    // User has many recent violations
    const userProfile = this.userProfiles.get(message.authorId);
    if (userProfile && userProfile.violationCount >= 3) {
      const recentViolations = userProfile.violations.filter(v => 
        Date.now() - v.timestamp.getTime() < 3600000 // Last hour
      );
      if (recentViolations.length >= 2) {
        return { shouldBlock: true, reason: 'repeat_offender', severity: 'high' };
      }
    }
    
    return { shouldBlock: false };
  }

  /**
   * Calculate AI priority (0-1 scale)
   */
  _calculateAIPriority(message, text) {
    let priority = 0;
    
    // Text-based factors
    if (this.smartRules.suspicious.some(pattern => pattern.test(text))) priority += 0.3;
    if (text.length > 100) priority += 0.1; // Longer messages need more analysis
    if (/[A-Z]{5,}/.test(message.message)) priority += 0.2; // Caps
    if (/(https?:\/\/|www\.)/.test(text)) priority += 0.3; // URLs
    
    // User-based factors
    const userProfile = this.userProfiles.get(message.authorId);
    if (userProfile) {
      if (userProfile.violationCount > 0) priority += 0.2;
      if (userProfile.messageCount < 3) priority += 0.1; // New users
      if (userProfile.averageMessageLength > 80) priority += 0.1; // Verbose users
    } else {
      priority += 0.2; // Unknown users
    }
    
    // Context factors
    if (this.stats.violationsFound > 0) {
      const violationRate = this.stats.violationsFound / this.stats.totalMessages;
      if (violationRate > 0.05) priority += 0.2; // High violation session
    }
    
    return Math.min(priority, 1.0);
  }

  /**
   * Fast-queue drainer. AI items are owned by the bounded `aiPool`.
   *
   * On every tick we drain up to `maxFast` rule-based items synchronously,
   * then yield. Busy-mode delay is 0ms (setImmediate-equivalent) so latency
   * for a hard-block message is microseconds, not tens of ms.
   */
  _startSmartProcessor() {
    const idleDelay =
      Number(this.config.get('smart.processorIdleDelayMs')) || 50;
    const busyDelay =
      Number(this.config.get('smart.processorBusyDelayMs')) || 0;
    const maxFast =
      Number(this.config.get('smart.maxFastBatchPerTick')) || 200;

    const tick = async () => {
      if (!this.isRunning) return;

      if (!this.processingActive && this.fastQueue.length > 0) {
        this.processingActive = true;
        try {
          let n = 0;
          while (this.fastQueue.length > 0 && n < maxFast) {
            const item = this.fastQueue.shift();
            await this._processFastItem(item);
            n++;
          }
        } catch (error) {
          console.error('Smart processing error:', error);
        }
        this.processingActive = false;
      }

      const delay = this.fastQueue.length > 0 ? busyDelay : idleDelay;
      if (this.isRunning) {
        this._processorTimer = setTimeout(tick, delay);
      }
    };

    this._processorTimer = setTimeout(tick, busyDelay);
  }

  /**
   * Process fast queue items (rule-based)
   */
  async _processFastItem(item) {
    const startTime = Date.now();
    const { message, decision } = item;
    
    let result = {
      isViolation: false,
      method: 'smart-rules',
      processingTime: 0,
      confidence: 0.9
    };

    if (decision.action === 'block') {
      result.isViolation = true;
      result.severity = decision.severity || 'medium';
      result.reasoning = decision.reason;
    }

    result.processingTime = Date.now() - startTime;
    
    // Record analysis
    this.analysisDatabase.push({
      messageId: message.id,
      message: message.message,
      author: message.author,
      timestamp: new Date(),
      analysis: result
    });

    this.stats.fastProcessed++;

    if (result.isViolation) {
      await this._handleViolation(message, result);
    }

    this.emit('verdict', {
      messageId: message.id,
      isViolation: result.isViolation,
      severity: result.severity || null,
      method: result.method,
      reasoning: result.reasoning || null,
      processingTime: result.processingTime
    });

    console.log(`Fast: ${result.isViolation ? '[violation]' : '[ok]'} "${message.message.substring(0, 30)}..." (${result.processingTime}ms)`);
  }

  /**
   * Process AI queue items (smart AI analysis)
   */
  async _processAIItem(item) {
    const startTime = Date.now();
    const { message, decision } = item;

    if (this.config.get('moderation.enabled') === false) {
      return;
    }
    
    try {
      // Get user context for better AI analysis
      const userContext = this._getUserContext(message.authorId);
      
      console.log(`AI analyzing [${decision.priority}]: "${message.message.substring(0, 40)}..."`);
      
      const analysis = await this.aiService.analyzeMessage(
        message.message,
        message.author,
        {
          userContext,
          isModerator: message.isModerator,
          isOwner: message.isOwner,
          priority: decision.priority,
          sessionContext: {
            violationRate: this.stats.violationsFound / this.stats.totalMessages,
            totalMessages: this.stats.totalMessages
          }
        }
      );

      analysis.processingTime = Date.now() - startTime;
      analysis.method = 'smart-ai';
      analysis.priority = decision.priority;

      // Smart caching - cache good results
      if (analysis.confidence > 0.8) {
        const cacheKey = this._generateSmartCacheKey(message.message);
        this.smartCache.set(cacheKey, {
          ...analysis,
          timestamp: Date.now()
        });
        
        // Clean cache if too large
        if (this.smartCache.size > 500) {
          const oldestKey = this.smartCache.keys().next().value;
          this.smartCache.delete(oldestKey);
        }
      }

      // Record analysis
      this.analysisDatabase.push({
        messageId: message.id,
        message: message.message,
        author: message.author,
        timestamp: new Date(),
        analysis: analysis
      });

      this.stats.aiProcessed++;
      this.stats.averageProcessingTime = (this.stats.averageProcessingTime + analysis.processingTime) / 2;

      if (analysis.isViolation) {
        await this._handleViolation(message, analysis);
      }

      this.emit('verdict', {
        messageId: message.id,
        isViolation: analysis.isViolation,
        severity: analysis.severity || null,
        method: analysis.method,
        reasoning: analysis.reasoning || null,
        processingTime: analysis.processingTime,
        confidence: analysis.confidence,
        ttfvMs: analysis.ttfvMs || null
      });

      console.log(`AI: ${analysis.isViolation ? '[violation]' : '[ok]'} [${decision.priority}] (${analysis.processingTime}ms, conf: ${analysis.confidence})`);

    } catch (error) {
      console.error(`AI analysis failed: ${error.message}`);

      // Fallback to conservative rules
      const fallback = this._conservativeFallback(message);
      this.analysisDatabase.push({
        messageId: message.id,
        message: message.message,
        author: message.author,
        timestamp: new Date(),
        analysis: { ...fallback, error: error.message }
      });

      if (fallback.isViolation) {
        await this._handleViolation(message, fallback);
      }
    }
  }

  /**
   * Handle cached results
   */
  _handleCachedResult(message, cachedResult) {
    console.log(`Cache: ${cachedResult.isViolation ? '[violation]' : '[ok]'} "${message.message.substring(0, 30)}..."`);
    
    this.stats.cacheHits++;
    
    // Record analysis from cache
    this.analysisDatabase.push({
      messageId: message.id,
      message: message.message,
      author: message.author,
      timestamp: new Date(),
      analysis: { ...cachedResult, method: 'smart-cache' }
    });

    if (cachedResult.isViolation) {
      this._handleViolation(message, cachedResult);
    }

    this.emit('verdict', {
      messageId: message.id,
      isViolation: !!cachedResult.isViolation,
      severity: cachedResult.severity || null,
      method: 'smart-cache',
      reasoning: cachedResult.reasoning || null,
      processingTime: 0,
      confidence: cachedResult.confidence
    });
  }

  /**
   * Handle violations
   */
  async _handleViolation(message, analysis) {
    this.stats.violationsFound++;
    
    // Update user profile
    const userProfile = this.userProfiles.get(message.authorId);
    if (userProfile) {
      userProfile.violationCount++;
      userProfile.violations.push({
        timestamp: new Date(),
        message: message.message,
        severity: analysis.severity,
        reasoning: analysis.reasoning
      });
    }

    const responseSpec = this._generateResponse(message, analysis, userProfile);
    const autoRespond = this.config.get('moderation.autoRespond');
    const autoTimeout = this.config.get('moderation.autoTimeout') === true;
    const autoBan = this.config.get('moderation.autoBan') === true;
    const timeoutSec = Math.min(
      3600,
      Math.max(60, Number(this.config.get('moderation.timeoutSeconds')) || 300)
    );

    let chatResponse = null;
    let responseSent = false;
    let responseError = null;

    let youtubeAction = 'none';
    let youtubeActionOk = false;
    let youtubeActionError = null;

    const canApplyYouTubeMod =
      message.authorId &&
      !message.isModerator &&
      !message.isOwner;

    if (canApplyYouTubeMod && responseSpec.actionType === 'timeout' && autoTimeout) {
      try {
        await this.youtubeService.timeoutLiveChatUser(
          message.authorId,
          this.youtubeService.liveChatId,
          timeoutSec
        );
        youtubeAction = 'timeout';
        youtubeActionOk = true;
      } catch (error) {
        youtubeAction = 'timeout';
        youtubeActionOk = false;
        youtubeActionError = error.message;
        console.error('YouTube timeout failed:', error.message);
      }
    } else if (canApplyYouTubeMod && responseSpec.actionType === 'ban' && autoBan) {
      try {
        await this.youtubeService.permanentlyBanLiveChatUser(
          message.authorId,
          this.youtubeService.liveChatId
        );
        youtubeAction = 'ban';
        youtubeActionOk = true;
      } catch (error) {
        youtubeAction = 'ban';
        youtubeActionOk = false;
        youtubeActionError = error.message;
        console.error('YouTube ban failed:', error.message);
      }
    }

    if (autoRespond && responseSpec?.text) {
      chatResponse = responseSpec.text;
      try {
        await this.youtubeService.sendMessage(chatResponse);
        responseSent = true;
      } catch (error) {
        console.error('Response failed:', error.message);
        responseError = error.message;
      }
    }

    this._recordModerationAction({
      message,
      analysis,
      actionType: responseSpec.actionType,
      plannedText: responseSpec.text,
      chatResponse,
      responseSent,
      responseError,
      autoRespondEnabled: !!autoRespond,
      youtubeAction,
      youtubeActionOk,
      youtubeActionError
    });

    console.log(`VIOLATION: ${message.author} - ${analysis.reasoning} [${analysis.method}]`);
    
    this.emit('violation', { message, analysis, userProfile });
  }

  /**
   * Persist one moderation action for UI / audit (newest last; trim to cap)
   */
  _recordModerationAction(entry) {
    const row = {
      id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      at: new Date().toISOString(),
      messageId: entry.message.id,
      author: entry.message.author,
      authorId: entry.message.authorId,
      actionType: entry.actionType,
      severity: entry.analysis.severity || 'unknown',
      method: entry.analysis.method || 'unknown',
      reasoning: String(entry.analysis.reasoning || '').slice(0, 500),
      messagePreview: String(entry.message.message || '').slice(0, 200),
      plannedText: entry.plannedText || null,
      chatResponse: entry.chatResponse || null,
      responseSent: entry.responseSent,
      responseError: entry.responseError || null,
      autoRespondEnabled: entry.autoRespondEnabled,
      youtubeAction: entry.youtubeAction || 'none',
      youtubeActionOk: entry.youtubeActionOk === true,
      youtubeActionError: entry.youtubeActionError || null
    };
    this.actionLog.push(row);
    if (this.actionLog.length > MAX_ACTION_LOG) {
      this.actionLog.splice(0, this.actionLog.length - MAX_ACTION_LOG);
    }
  }

  /**
   * Escalation tier for templates. YouTube liveChatBans runs separately when
   * moderation.autoTimeout / moderation.autoBan are enabled (see _handleViolation).
   */
  _determineActionType(analysis, userProfile) {
    const violationCount = userProfile?.violationCount || 1;
    const sev = analysis.severity || 'low';
    if (violationCount >= 3 || sev === 'high') return 'ban';
    if (sev === 'medium') return 'timeout';
    return 'warning';
  }

  getModerationActions(limit = 50, offset = 0) {
    const total = this.actionLog.length;
    const lim = Math.min(200, Math.max(1, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const newestFirst = [...this.actionLog].reverse();
    const slice = newestFirst.slice(off, off + lim);
    return { actions: slice, total, offset: off, limit: lim };
  }

  _actionCountsFromLog() {
    const c = { warning: 0, timeout: 0, ban: 0 };
    for (const a of this.actionLog) {
      if (c[a.actionType] !== undefined) c[a.actionType]++;
    }
    return c;
  }

  /**
   * Initialize smart rules
   */
  _initializeSmartRules() {
    return {
      critical: [
        /\b(kill\s+yourself|kys|suicide|hang\s+yourself)\b/i,
        /\b(terrorist|bomb|kill\s+everyone|shoot\s+up)\b/i,
        /\b(rape|molest|child\s+abuse)\b/i
      ],
      suspicious: [
        /\b(hate|stupid|idiot|moron|dumb|pathetic)\b/i,
        /\b(scam|fake|fraud|cheat|spam)\b/i,
        /\b(f[*u]ck|sh[*i]t|damn|hell)\b/i
      ]
    };
  }

  /**
   * Check for obvious spam
   */
  _isObviousSpam(text, message) {
    // Character repetition
    if (/(.)\1{4,}/.test(text)) return true;
    
    // Excessive caps
    if (text.length > 10 && text === text.toUpperCase()) return true;
    
    // Too many emojis
    const emojiCount = (text.match(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]/gu) || []).length;
    if (emojiCount > 5) return true;
    
    return false;
  }

  /**
   * Generate smart cache key
   */
  _generateSmartCacheKey(message) {
    // Normalize message for caching
    return message.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 60);
  }

  /**
   * Get user context
   */
  _getUserContext(userId) {
    const profile = this.userProfiles.get(userId);
    if (!profile) return {};

    return {
      messageCount: profile.messageCount,
      violationCount: profile.violationCount,
      averageMessageLength: profile.averageMessageLength || 0,
      isRegular: profile.messageCount > 5,
      recentViolations: profile.violations.slice(-3)
    };
  }

  /**
   * Update user profiles
   */
  _updateUserProfile(message) {
    let profile = this.userProfiles.get(message.authorId);
    
    if (!profile) {
      profile = {
        userId: message.authorId,
        username: message.author,
        messageCount: 0,
        violationCount: 0,
        violations: [],
        totalCharacters: 0,
        averageMessageLength: 0,
        firstSeen: message.timestamp,
        isModerator: message.isModerator,
        isOwner: message.isOwner
      };
    }

    profile.messageCount++;
    profile.totalCharacters += message.messageLength;
    profile.averageMessageLength = profile.totalCharacters / profile.messageCount;
    profile.lastSeen = message.timestamp;
    
    this.userProfiles.set(message.authorId, profile);
  }

  /**
   * Extract message data
   */
  _extractMessageData(rawMessage) {
    return {
      id: rawMessage.id,
      message: rawMessage.snippet.textMessageDetails?.messageText || '',
      author: rawMessage.authorDetails.displayName,
      authorId: rawMessage.authorDetails.channelId,
      timestamp: new Date(rawMessage.snippet.publishedAt),
      messageLength: (rawMessage.snippet.textMessageDetails?.messageText || '').length,
      isModerator: rawMessage.authorDetails.isChatModerator,
      isOwner: rawMessage.authorDetails.isChatOwner,
      isSponsored: rawMessage.authorDetails.isChatSponsor
    };
  }

  /**
   * Conservative fallback for AI failures
   */
  _conservativeFallback(message) {
    const text = message.message.toLowerCase();
    
    if (this.smartRules.critical.some(pattern => pattern.test(text))) {
      return {
        isViolation: true,
        severity: 'high',
        reasoning: 'Critical content detected',
        method: 'fallback-conservative',
        confidence: 0.8
      };
    }
    
    return {
      isViolation: false,
      reasoning: 'AI failed, passed by fallback',
      method: 'fallback-safe',
      confidence: 0.5
    };
  }

  /**
   * Generate response text + escalation tier for logging
   */
  _generateResponse(message, analysis, userProfile) {
    const templates = this.config.get('moderation.responses') || {};
    const actionType = this._determineActionType(analysis, userProfile);
    let text;

    if (actionType === 'ban') {
      text =
        templates.ban?.replace('{author}', message.author) ||
        `${message.author} ❌ Multiple violations - action taken`;
    } else if (actionType === 'timeout') {
      text =
        templates.timeout?.replace('{author}', message.author) ||
        `${message.author} 🚫 Please follow chat guidelines`;
    } else {
      text =
        templates.warning?.replace('{author}', message.author) ||
        `${message.author} ⚠️ Keep chat respectful please`;
    }

    return { text, actionType };
  }

  /**
   * Process remaining queues before shutdown
   */
  async _processRemainingQueues() {
    console.log(
      `Processing remaining: ${this.fastQueue.length} fast, ${this.aiPool?.size() || 0} AI queued, ${this.aiPool?.inflightCount() || 0} AI inflight`
    );

    while (this.fastQueue.length > 0) {
      const item = this.fastQueue.shift();
      await this._processFastItem(item);
    }

    if (this.aiPool) {
      await this.aiPool.drainAndStop();
      this.aiPool = null;
    }
  }

  /**
   * Ensure storage directory
   */
  async _ensureStorageDir() {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
    } catch (error) {
      console.error('Storage directory error:', error);
    }
  }

  /**
   * Load existing data
   */
  async _loadExistingData() {
    try {
      const messagesData = await fs.readFile(this.messagesFile, 'utf8');
      this.messageDatabase = JSON.parse(messagesData);
      
      const analysisData = await fs.readFile(this.analysisFile, 'utf8');
      this.analysisDatabase = JSON.parse(analysisData);
      
      console.log(`Loaded ${this.messageDatabase.length} messages, ${this.analysisDatabase.length} analyses`);
    } catch (error) {
      console.log('Starting fresh - no existing data');
    }
    try {
      const actionsData = await fs.readFile(this.actionsFile, 'utf8');
      const parsed = JSON.parse(actionsData);
      if (Array.isArray(parsed)) {
        this.actionLog = parsed.slice(-MAX_ACTION_LOG);
        console.log(`Loaded ${this.actionLog.length} moderation actions`);
      }
    } catch (error) {
      // optional file
    }
  }

  /**
   * Save data
   */
  async _saveData() {
    try {
      await fs.writeFile(this.messagesFile, JSON.stringify(this.messageDatabase, null, 2));
      await fs.writeFile(this.analysisFile, JSON.stringify(this.analysisDatabase, null, 2));
      await fs.writeFile(this.actionsFile, JSON.stringify(this.actionLog, null, 2));
    } catch (error) {
      console.error('Save error:', error);
    }
  }

  /**
   * Generate smart report
   */
  _generateSmartReport() {
    const duration = Date.now() - (this.stats.sessionStart?.getTime() || Date.now());
    
    return {
      summary: {
        mode: 'smart-balanced',
        duration: Math.round(duration / 1000),
        totalMessages: this.stats.totalMessages,
        fastProcessed: this.stats.fastProcessed,
        aiProcessed: this.stats.aiProcessed,
        cacheHits: this.stats.cacheHits,
        violationsFound: this.stats.violationsFound
      },
      efficiency: {
        aiUsageRate: Math.round((this.stats.aiProcessed / this.stats.totalMessages) * 100),
        cacheEfficiency: Math.round((this.stats.cacheHits / this.stats.totalMessages) * 100),
        averageProcessingTime: Math.round(this.stats.averageProcessingTime)
      },
      decisions: this.stats.smartDecisions,
      dataFiles: {
        messages: this.messagesFile,
        analysis: this.analysisFile,
        actions: this.actionsFile
      }
    };
  }

  /**
   * Get smart statistics
   */
  getSmartStats() {
    const total = this.stats.totalMessages;
    const aiUsageRate =
      total > 0 ? Math.round((this.stats.aiProcessed / total) * 100) : 0;
    const cacheHitRate =
      total > 0 ? Math.round((this.stats.cacheHits / total) * 100) : 0;
    const avgResponseTime = Math.round(this.stats.averageProcessingTime);
    const skipped =
      (this.stats.smartDecisions?.immediateAllow || 0) +
      (this.stats.smartDecisions?.immediateBlock || 0);

    return {
      isRunning: this.isRunning,
      mode: 'smart-balanced',
      totalMessages: this.stats.totalMessages,
      // Dashboard-compatible flat fields
      flaggedMessages: this.stats.violationsFound,
      aiProcessed: this.stats.aiProcessed,
      efficiency:
        total > 0 ? Math.max(0, 100 - aiUsageRate) : 0,
      avgResponseTime,
      cacheHitRate,
      processed: this.stats.aiProcessed,
      cached: this.stats.cacheHits,
      skipped,
      processing: {
        fastQueue: this.fastQueue.length,
        aiQueue: this.aiPool ? this.aiPool.size() : 0,
        aiInflight: this.aiPool ? this.aiPool.inflightCount() : 0,
        fastProcessed: this.stats.fastProcessed,
        aiProcessed: this.stats.aiProcessed,
        cacheHits: this.stats.cacheHits
      },
      pollDelayMs: this._lastPollDelayMs,
      efficiencyDetail: {
        aiUsageRate,
        cacheHitRate,
        averageProcessingTime: avgResponseTime
      },
      violations: {
        total: this.stats.violationsFound,
        rate:
          total > 0
            ? Math.round((this.stats.violationsFound / total) * 100)
            : 0
      },
      moderationActions: this._actionCountsFromLog(),
      smartDecisions: this.stats.smartDecisions,
      cacheSize: this.smartCache.size,
      userProfiles: this.userProfiles.size
    };
  }
}

module.exports = ChatMonitor;