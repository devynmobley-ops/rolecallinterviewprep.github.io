/**
 * ApplicationProviderManager — Routes application requests to the appropriate provider.
 *
 * Selects providers based on:
 *   1. The application mode (manual, assisted, automated)
 *   2. The job's ATS type (if detectable)
 *   3. Provider availability and capabilities
 *   4. User preferences and subscription level
 *
 * The manager NEVER fabricates user data. It delegates to providers
 * which must return needsUserAction for missing information.
 */

const { ManualProvider } = require('./providers/ManualProvider');
const { AssistedProvider } = require('./providers/AssistedProvider');
const { AutomatedProvider } = require('./providers/AutomatedProvider');

class ApplicationProviderManager {
  constructor() {
    this.providers = new Map();
    this.registerDefaults();
  }

  /**
   * Register default providers.
   */
  registerDefaults() {
    this.register(new ManualProvider());
    this.register(new AssistedProvider());
    this.register(new AutomatedProvider());
  }

  /**
   * Register a provider.
   * @param {ApplicationProvider} provider
   */
  register(provider) {
    const name = provider.getProviderName();
    this.providers.set(name, provider);
    console.log(`[ProviderManager] Registered provider: ${name}`);
  }

  /**
   * Get a provider by name.
   * @param {string} name
   * @returns {ApplicationProvider|null}
   */
  getProvider(name) {
    return this.providers.get(name) || null;
  }

  /**
   * Select the best provider for a given job and mode.
   *
   * @param {Object} job - Normalized RoleCall job
   * @param {string} mode - "manual" | "assisted" | "automated"
   * @param {Object} userProfile - User's profile data
   * @returns {ApplicationProvider}
   */
  selectProvider(job, mode = 'manual', userProfile = {}) {
    // Manual mode always uses ManualProvider
    if (mode === 'manual') {
      return this.providers.get('manual');
    }

    // Assisted mode uses AssistedProvider
    if (mode === 'assisted') {
      return this.providers.get('assisted');
    }

    // Automated mode: try automated providers, fall back to assisted
    if (mode === 'automated') {
      const automated = this.providers.get('automated');
      if (automated) return automated;
      // Fall back to assisted if no automated provider available
      return this.providers.get('assisted');
    }

    // Default to manual
    return this.providers.get('manual');
  }

  /**
   * Analyze a job across all capable providers.
   * Returns the best provider for the job.
   *
   * @param {Object} job - Normalized RoleCall job
   * @param {Object} userProfile - User's profile data
   * @returns {Promise<{ provider: ApplicationProvider, analysis: Object }>}
   */
  async analyzeForBestProvider(job, userProfile = {}) {
    const results = [];

    for (const [name, provider] of this.providers) {
      try {
        const analysis = await provider.analyzeJob(job, userProfile);
        if (analysis.canApply) {
          results.push({ provider, analysis, name });
        }
      } catch (err) {
        console.error(`[ProviderManager] Error analyzing with ${name}:`, err.message);
      }
    }

    // Sort by confidence (highest first)
    results.sort((a, b) => b.analysis.confidence - a.analysis.confidence);

    if (results.length > 0) {
      return results[0];
    }

    // No provider can handle it — return manual as fallback
    return {
      provider: this.providers.get('manual'),
      analysis: {
        canApply: true,
        confidence: 0.5,
        atsType: 'unknown',
        estimatedDifficulty: 'medium',
        missingFields: [],
        warnings: ['No automated provider available for this job.'],
        estimatedTime: null,
        requiresLogin: false,
        supportsAutoFill: false,
      },
      name: 'manual',
    };
  }

  /**
   * Get all registered provider names.
   * @returns {string[]}
   */
  getProviderNames() {
    return Array.from(this.providers.keys());
  }

  /**
   * Get capabilities of all providers.
   * @returns {Object}
   */
  getAllCapabilities() {
    const caps = {};
    for (const [name, provider] of this.providers) {
      caps[name] = provider.getCapabilities();
    }
    return caps;
  }
}

// Singleton instance
let _instance = null;

function getProviderManager() {
  if (!_instance) {
    _instance = new ApplicationProviderManager();
  }
  return _instance;
}

module.exports = { ApplicationProviderManager, getProviderManager };