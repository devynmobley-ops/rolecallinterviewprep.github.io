/**
 * Deduplicator — Prevents the same job from appearing multiple times.
 * 
 * Uses a combination of:
 *   1. Deduplication key (company + title + location)
 *   2. External ID from the same source
 *   3. Application URL matching
 * 
 * When duplicates are found, the most recent/superset version is kept.
 */

const admin = require('firebase-admin');

/**
 * Check if a job already exists in Firestore.
 * Returns the existing job doc if found, null otherwise.
 * 
 * @param {Object} job - Normalized RoleCall job
 * @param {Object} db - Firestore database instance
 * @returns {Object|null} Existing job document snapshot or null
 */
async function findDuplicate(job, db) {
  const jobsRef = db.collection('jobs');
  
  // Strategy 1: Check deduplication key
  const dedupSnap = await jobsRef
    .where('deduplicationKey', '==', job.deduplicationKey)
    .where('active', '==', true)
    .limit(1)
    .get();
  
  if (!dedupSnap.empty) {
    return dedupSnap.docs[0];
  }
  
  // Strategy 2: Check external ID from same source
  if (job.externalId && job.sourceId) {
    const extSnap = await jobsRef
      .where('sourceId', '==', job.sourceId)
      .where('externalId', '==', job.externalId)
      .limit(1)
      .get();
    
    if (!extSnap.empty) {
      return extSnap.docs[0];
    }
  }
  
  // Strategy 3: Check application URL (if meaningful)
  if (job.applicationUrl && job.applicationUrl.length > 20) {
    const urlSnap = await jobsRef
      .where('applicationUrl', '==', job.applicationUrl)
      .where('active', '==', true)
      .limit(1)
      .get();
    
    if (!urlSnap.empty) {
      return urlSnap.docs[0];
    }
  }
  
  return null;
}

/**
 * Merge two jobs — keeps the best data from both.
 * Used when a duplicate is found and we want to update rather than replace.
 * 
 * @param {Object} existing - The existing job from Firestore
 * @param {Object} incoming - The new job data
 * @returns {Object} Merged job data
 */
function mergeJobs(existing, incoming) {
  const merged = { ...existing };
  
  // Always update sync timestamp
  merged.lastSyncedAt = new Date();
  
  // Update fields if incoming has better data
  if (incoming.description && incoming.description.length > (existing.description || '').length) {
    merged.description = incoming.description;
  }
  
  if (incoming.companyLogo && !existing.companyLogo) {
    merged.companyLogo = incoming.companyLogo;
  }
  
  if (incoming.salaryMin && !existing.salaryMin) {
    merged.salaryMin = incoming.salaryMin;
  }
  if (incoming.salaryMax && !existing.salaryMax) {
    merged.salaryMax = incoming.salaryMax;
  }
  
  // Merge skills (union)
  if (incoming.skills && incoming.skills.length > 0) {
    const existingSkills = new Set(existing.skills || []);
    for (const skill of incoming.skills) {
      existingSkills.add(skill);
    }
    merged.skills = Array.from(existingSkills).slice(0, 15);
  }
  
  // Merge requirements (union)
  if (incoming.requirements && incoming.requirements.length > 0) {
    const existingReqs = new Set(existing.requirements || []);
    for (const req of incoming.requirements) {
      existingReqs.add(req);
    }
    merged.requirements = Array.from(existingReqs).slice(0, 10);
  }
  
  // Keep the latest postedAt
  if (incoming.postedAt && (!existing.postedAt || incoming.postedAt > existing.postedAt)) {
    merged.postedAt = incoming.postedAt;
  }
  
  // Keep the latest expiresAt
  if (incoming.expiresAt && (!existing.expiresAt || incoming.expiresAt > existing.expiresAt)) {
    merged.expiresAt = incoming.expiresAt;
  }
  
  return merged;
}

/**
 * Process an array of incoming jobs — deduplicate and either create or update.
 * Returns stats about what happened.
 * 
 * @param {Array} jobs - Array of normalized jobs
 * @param {Object} db - Firestore database instance
 * @returns {{ created: number, updated: number, skipped: number, errors: number }}
 */
async function processJobs(jobs, db) {
  const stats = { created: 0, updated: 0, skipped: 0, errors: 0 };
  const batch = db.batch();
  let batchCount = 0;
  const BATCH_LIMIT = 450; // Firestore batch limit is 500, leave margin
  
  for (const job of jobs) {
    try {
      const existing = await findDuplicate(job, db);
      
      if (existing) {
        // Merge and update
        const merged = mergeJobs(existing.data(), job);
        batch.set(existing.ref, merged, { merge: true });
        stats.updated++;
      } else {
        // Create new
        const newRef = db.collection('jobs').doc();
        batch.set(newRef, job);
        stats.created++;
      }
      
      batchCount++;
      
      // Commit batch if near limit
      if (batchCount >= BATCH_LIMIT) {
        await batch.commit();
        batchCount = 0;
      }
    } catch (err) {
      console.error(`[Dedup] Error processing job "${job.title}":`, err.message);
      stats.errors++;
    }
  }
  
  // Commit remaining
  if (batchCount > 0) {
    await batch.commit();
  }
  
  return stats;
}

module.exports = { findDuplicate, mergeJobs, processJobs };
