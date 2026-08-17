/**
 * Normalizer — Ensures all jobs conform to the RoleCall schema.
 * 
 * Takes a provider's normalizeJob() output and applies additional
 * cleaning, validation, and enrichment.
 */

/**
 * Normalize a job from any provider into a clean RoleCall job.
 * @param {Object} job - Output from a provider's normalizeJob()
 * @param {Object} source - The JobSource instance (for generateDedupKey)
 * @returns {Object} Cleaned and validated job
 */
function normalizeJob(job, source) {
  const normalized = {
    ...job,
    // Ensure required fields
    title: sanitize(job.title || 'Untitled Position'),
    company: sanitize(job.company || 'Unknown Company'),
    description: sanitize(job.description || ''),
    location: sanitize(job.location || 'Unknown'),
    
    // Clean strings
    companyLogo: job.companyLogo || null,
    employmentType: normalizeEmploymentType(job.employmentType),
    seniority: normalizeSeniority(job.seniority),
    salaryCurrency: job.salaryCurrency || 'USD',
    category: job.category || null,
    
    // Ensure arrays
    skills: Array.isArray(job.skills) ? job.skills.map(s => sanitize(s)).filter(Boolean) : [],
    requirements: Array.isArray(job.requirements) ? job.requirements.map(r => sanitize(r)).filter(Boolean) : [],
    
    // Ensure booleans
    remote: !!job.remote,
    hybrid: !!job.hybrid,
    active: job.active !== false, // Default true
    
    // Ensure dates are Date objects or null
    postedAt: toDate(job.postedAt),
    expiresAt: toDate(job.expiresAt),
    importedAt: toDate(job.importedAt) || new Date(),
    lastSyncedAt: toDate(job.lastSyncedAt) || new Date(),
    
    // Validate URLs
    applicationUrl: sanitizeUrl(job.applicationUrl),
    sourceUrl: sanitizeUrl(job.sourceUrl),
  };
  
  // Generate deduplication key
  normalized.deduplicationKey = source.generateDedupKey(normalized);
  
  // Derive remote from hybrid
  if (normalized.hybrid && !normalized.remote) {
    // Hybrid implies partially remote — keep hybrid=true, remote=false
  }
  
  return normalized;
}

/**
 * Sanitize a string — remove control characters, trim, limit length.
 */
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control chars
    .trim()
    .substring(0, 5000); // Reasonable max length
}

/**
 * Normalize employment type to a consistent set.
 */
function normalizeEmploymentType(type) {
  if (!type) return 'full-time';
  const lower = type.toLowerCase().trim();
  
  if (lower.includes('full') || lower.includes('permanent')) return 'full-time';
  if (lower.includes('part')) return 'part-time';
  if (lower.includes('contract') || lower.includes('freelance')) return 'contract';
  if (lower.includes('intern')) return 'internship';
  if (lower.includes('temp')) return 'contract';
  
  return 'full-time';
}

/**
 * Normalize seniority to a consistent set.
 */
function normalizeSeniority(level) {
  if (!level) return 'mid';
  const lower = level.toLowerCase().trim();
  
  if (['entry', 'junior', 'associate', 'assistant', 'intern'].includes(lower)) return 'entry';
  if (['mid', 'mid-level', 'intermediate', 'experienced'].includes(lower)) return 'mid';
  if (['senior', 'lead', 'principal', 'staff'].includes(lower)) return 'senior';
  if (['executive', 'director', 'manager', 'vp', 'chief'].includes(lower)) return 'executive';
  
  return 'mid';
}

/**
 * Safely convert a value to a Date or null.
 */
function toDate(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  if (typeof val === 'number') return new Date(val);
  if (typeof val === 'string') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }
  // Firestore Timestamp
  if (val.toDate && typeof val.toDate === 'function') return val.toDate();
  return null;
}

/**
 * Sanitize a URL — ensure it's a valid HTTP(S) URL.
 */
function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return '';
}

/**
 * Prepare a job for Firestore storage.
 * Converts Date objects to Firestore Timestamps.
 */
function toFirestoreJob(job, admin) {
  const firestoreJob = { ...job };
  
  // Convert dates to Firestore Timestamps
  if (firestoreJob.postedAt instanceof Date) {
    firestoreJob.postedAt = admin.firestore.Timestamp.fromDate(firestoreJob.postedAt);
  }
  if (firestoreJob.expiresAt instanceof Date) {
    firestoreJob.expiresAt = admin.firestore.Timestamp.fromDate(firestoreJob.expiresAt);
  }
  if (firestoreJob.importedAt instanceof Date) {
    firestoreJob.importedAt = admin.firestore.Timestamp.fromDate(firestoreJob.importedAt);
  }
  if (firestoreJob.lastSyncedAt instanceof Date) {
    firestoreJob.lastSyncedAt = admin.firestore.Timestamp.fromDate(firestoreJob.lastSyncedAt);
  }
  
  return firestoreJob;
}

module.exports = { normalizeJob, toFirestoreJob };
