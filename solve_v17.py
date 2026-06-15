"""
solve_v17.py - Improved on v16
v16 platform: score=0.9465, has_anomaly_f1=0.9999, span_iou=0.9159, anomaly_type_f1=0.9672

Key improvements:
1. Enhanced sample features for type classification
2. Secondary TF-IDF type classifier (ensemble with LGB)
3. Per-type span length predictor (dynamic search range)
4. Enhanced candidate features (distribution, AUC, boundary sharpness)
5. 5-pass refinement with dynamic initial search
6. Fix: test section uses correct sv_s variable
"""
import pandas as pd
import numpy as np
import re
from collections import Counter
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.svm import LinearSVC
from sklearn.calibration import CalibratedClassifierCV
from sklearn.model_selection import StratifiedKFold
from sklearn.metrics import f1_score
from scipy.sparse import hstack, csr_matrix
import lightgbm as lgb
import warnings
warnings.filterwarnings('ignore')

print("Loading data...")
train_df = pd.read_csv('F:/train/train.csv')
test_df = pd.read_csv('F:/train/test.csv')

TYPE_KEYWORDS = {
    'cross_component_mismatch': ['handoff', 'contract', 'alignment', 'revision', 'reconcile', 'non_alignment', 'remained', 'differed', 'cross_component', 'lane_a', 'lane_b'],
    'duplicate_event': ['delivery', 'duplicate', 'suspected', 'segment_cache', 'ack_loop', 'twice', 'repeated', 'replay'],
    'slow_burn_warning': ['climbed', 'expanding', 'rising', 'queue', 'latency', 'breached', 'wait_ms', 'still', 'gradual'],
    'out_of_order': ['backward', 'unexpectedly', 'moved', 'ordering', 'sequence', 'reversed'],
    'timeout_retry': ['re_attempt', 'budget', 'exhausted', 'timeout', 'deadline_narrow', 'fallback', 'response', 'attempt'],
    'parameter_drift': ['profile', 'margin', 'outside', 'drift', 'shifted', 'exceeded', 'threshold', 'baseline'],
    'partial_recovery_loop': ['stabilization', 'repeated', 'recovery', 'repair', 'entered', 'loop', 'phase', 'cycle'],
    'missing_step': ['commit', 'marker', 'stage', 'expected', 'observed', 'skipped', 'absent', 'missing'],
    'resource_exhaustion': ['pressure', 'reserve', 'write', 'path', 'exhausted', 'capacity', 'usage', 'limit'],
    'state_conflict': ['state', 'transition', 'disagreement', 'verify', 'conflict', 'inconsistent', 'overlap'],
}
ANOMALY_INDICATORS = [
    'error', 'warn', 'exception', 'timeout', 'fail', 'failed', 'exhausted',
    'detected', 'suspected', 'breached', 'climbed', 'rising', 'expanding',
    'backward', 'unexpectedly', 'drift', 'conflict', 'duplicate', 'repeated',
    'pressure', 'recovery', 'loop', 'skipped', 'absent', 'marker',
    're_attempt', 'budget', 'fallback', 'deadline', 'critical',
    'non_alignment', 'differed', 'reconcile', 'handoff',
]
TYPE_SPAN_MODE = {
    'cross_component_mismatch': 4, 'duplicate_event': 4, 'missing_step': 3,
    'out_of_order': 3, 'parameter_drift': 4, 'partial_recovery_loop': 5,
    'resource_exhaustion': 4, 'slow_burn_warning': 7, 'state_conflict': 4,
    'timeout_retry': 6,
}
TYPE_CATEGORIES = sorted(TYPE_SPAN_MODE.keys())

# ===== FUNCTIONS =====
def parse_timestamp(ts):
    match = re.match(r'(\d{2}):(\d{2}):(\d{2})\.(\d{3})', str(ts))
    if match:
        h, m, s, ms = match.groups()
        return int(h)*3600000 + int(m)*60000 + int(s)*1000 + int(ms)
    return 0

def extract_features(log_lines, line_indices):
    lines = [log_lines[i] for i in line_indices]
    text = ' '.join(lines)
    words = re.findall(r'\w+', text.lower())
    word_counts = Counter(words)

    features = {}
    features['n_lines'] = len(lines)
    features['n_words'] = len(words)
    features['n_unique_words'] = len(set(words))
    features['avg_line_len'] = np.mean([len(l) for l in lines]) if lines else 0
    features['std_line_len'] = np.std([len(l) for l in lines]) if lines else 0
    features['max_line_len'] = max([len(l) for l in lines]) if lines else 0
    features['min_line_len'] = min([len(l) for l in lines]) if lines else 0

    for kw in ANOMALY_INDICATORS:
        features[f'kw_{kw}'] = word_counts.get(kw, 0)

    for atype, kws in TYPE_KEYWORDS.items():
        features[f'typekw_{atype}'] = sum(word_counts.get(kw, 0) for kw in kws)

    # Numbers and special patterns
    numbers = [int(x) for x in re.findall(r'\b\d+\b', text)]
    features['n_numbers'] = len(numbers)
    features['sum_numbers'] = sum(numbers) if numbers else 0
    features['mean_numbers'] = np.mean(numbers) if numbers else 0
    features['std_numbers'] = np.std(numbers) if numbers else 0
    features['max_number'] = max(numbers) if numbers else 0
    features['min_number'] = min(numbers) if numbers else 0

    features['n_equals'] = text.count('=')
    features['n_gt'] = text.count('>')
    features['n_lt'] = text.count('<')
    features['n_percent'] = text.count('%')
    features['n_dash'] = text.count('-')
    features['n_underscore'] = text.count('_')
    features['n_dot'] = text.count('.')
    features['n_comma'] = text.count(',')
    features['n_slash'] = text.count('/')

    features['has_error'] = int(bool(re.search(r'error|ERROR', text)))
    features['has_warn'] = int(bool(re.search(r'warn|WARN', text)))
    features['has_critical'] = int(bool(re.search(r'critical|CRITICAL', text)))
    features['has_detected'] = int('detected' in text.lower())
    features['has_timeout'] = int('timeout' in text.lower())
    features['has_exhausted'] = int('exhausted' in text.lower())
    features['has_drift'] = int('drift' in text.lower())
    features['has_conflict'] = int('conflict' in text.lower())
    features['has_duplicate'] = int('duplicate' in text.lower())
    features['has_repeated'] = int('repeated' in text.lower())
    features['has_skipped'] = int('skipped' in text.lower())
    features['has_reversed'] = int('reversed' in text.lower())
    features['has_loop'] = int('loop' in text.lower())
    features['has_recovery'] = int('recovery' in text.lower())
    features['has_handoff'] = int('handoff' in text.lower())
    features['has_reconcile'] = int('reconcile' in text.lower())

    # Timestamp features
    timestamps = [parse_timestamp(re.search(r'(\d{2}:\d{2}:\d{2}\.\d{3})', l).group(1))
                  for l in lines if re.search(r'(\d{2}:\d{2}:\d{2}\.\d{3})', l)]
    if len(timestamps) >= 2:
        diffs = np.diff(timestamps)
        features['ts_range'] = timestamps[-1] - timestamps[0]
        features['ts_mean_diff'] = np.mean(diffs)
        features['ts_std_diff'] = np.std(diffs)
        features['ts_max_diff'] = np.max(diffs)
        features['ts_min_diff'] = np.min(diffs)
    else:
        features['ts_range'] = 0
        features['ts_mean_diff'] = 0
        features['ts_std_diff'] = 0
        features['ts_max_diff'] = 0
        features['ts_min_diff'] = 0

    # Key=value pair features
    kv_pairs = re.findall(r'(\w+)=([\w.]+)', text)
    features['n_kv_pairs'] = len(kv_pairs)
    kv_keys = [k for k, v in kv_pairs]
    features['n_unique_kv_keys'] = len(set(kv_keys))

    # Specific field values
    for field in ['frame_id', 'latency_ms', 'tx_id', 'rate', 'margin', 'wait_ms',
                  'attempt', 'budget', 'reserve', 'profile', 'count', 'offset',
                  'seq']:
        vals = [float(v) for k, v in kv_pairs if k == field and re.match(r'^-?\d+\.?\d*$', v)]
        if vals:
            features[f'kv_{field}_mean'] = np.mean(vals)
            features[f'kv_{field}_std'] = np.std(vals)
            features[f'kv_{field}_max'] = np.max(vals)
            features[f'kv_{field}_min'] = np.min(vals)
            features[f'kv_{field}_range'] = np.max(vals) - np.min(vals)
            if len(vals) >= 2:
                diffs = np.diff(vals)
                features[f'kv_{field}_mean_diff'] = np.mean(diffs)
                features[f'kv_{field}_max_diff'] = np.max(np.abs(diffs))
            else:
                features[f'kv_{field}_mean_diff'] = 0
                features[f'kv_{field}_max_diff'] = 0
        else:
            features[f'kv_{field}_mean'] = 0
            features[f'kv_{field}_std'] = 0
            features[f'kv_{field}_max'] = 0
            features[f'kv_{field}_min'] = 0
            features[f'kv_{field}_range'] = 0
            features[f'kv_{field}_mean_diff'] = 0
            features[f'kv_{field}_max_diff'] = 0

    # Line-level metrics
    metrics = []
    for l in lines:
        lm = {}
        lm['latency'] = float(re.search(r'latency_ms=(\d+)', l).group(1)) if re.search(r'latency_ms=(\d+)', l) else -1
        lm['rate'] = float(re.search(r'rate=([\d.]+)', l).group(1)) if re.search(r'rate=([\d.]+)', l) else -1
        lm['frame_id'] = int(re.search(r'frame_id=(\d+)', l).group(1)) if re.search(r'frame_id=(\d+)', l) else -1
        metrics.append(lm)
    features['avg_latency'] = np.mean([m['latency'] for m in metrics if m['latency'] >= 0]) if any(m['latency'] >= 0 for m in metrics) else -1
    features['max_latency'] = max([m['latency'] for m in metrics if m['latency'] >= 0]) if any(m['latency'] >= 0 for m in metrics) else -1
    features['avg_rate'] = np.mean([m['rate'] for m in metrics if m['rate'] >= 0]) if any(m['rate'] >= 0 for m in metrics) else -1
    features['max_rate'] = max([m['rate'] for m in metrics if m['rate'] >= 0]) if any(m['rate'] >= 0 for m in metrics) else -1

    # Word diversity and repetition
    if words:
        word_freq = Counter(words)
        features['word_entropy'] = -sum((c/len(words)) * np.log2(c/len(words)) for c in word_freq.values())
        features['max_word_freq'] = max(word_freq.values())
        features['repeat_ratio'] = 1 - len(set(words)) / len(words)
    else:
        features['word_entropy'] = 0
        features['max_word_freq'] = 0
        features['repeat_ratio'] = 0

    return features


def extract_candidate_features(log_lines, start, end, section_stats):
    """Extract features specific to a candidate window."""
    lines = log_lines[start:end+1]
    text = ' '.join(lines)
    words = re.findall(r'\w+', text.lower())

    feat = {}

    # Position in section
    sec_start, sec_end = section_stats['range']
    sec_len = sec_end - sec_start + 1
    if sec_len > 1:
        feat['rel_start'] = (start - sec_start) / sec_len
        feat['rel_end'] = (end - sec_start) / sec_len
        feat['rel_center'] = ((start + end) / 2 - sec_start) / sec_len
    else:
        feat['rel_start'] = 0
        feat['rel_end'] = 0
        feat['rel_center'] = 0

    feat['span_len'] = end - start + 1
    feat['span_words'] = len(words)

    # Anomaly indicator density
    total_ind = sum(words.count(kw) for kw in ANOMALY_INDICATORS)
    feat['anomaly_density'] = total_ind / max(len(words), 1)
    feat['anomaly_count'] = total_ind

    # Type keyword densities
    for atype, kws in TYPE_KEYWORDS.items():
        cnt = sum(words.count(kw) for kw in kws)
        feat[f'type_density_{atype}'] = cnt / max(len(words), 1)
        feat[f'type_count_{atype}'] = cnt

    # Distribution features: how concentrated are indicators?
    indicator_positions = []
    for i, l in enumerate(lines):
        lw = re.findall(r'\w+', l.lower())
        ind_count = sum(w in ANOMALY_INDICATORS for w in lw)
        indicator_positions.append(ind_count)
    if indicator_positions:
        feat['ind_positions_std'] = np.std(indicator_positions)
        feat['ind_positions_max'] = max(indicator_positions)
        feat['ind_positions_nonzero'] = sum(1 for p in indicator_positions if p > 0) / len(indicator_positions)
        # AUC-like: cumulative distribution
        cumsum = np.cumsum(indicator_positions)
        if cumsum[-1] > 0:
            normalized = cumsum / cumsum[-1]
            feat['ind_auc'] = np.trapz(normalized) / len(normalized)
        else:
            feat['ind_auc'] = 0.5
    else:
        feat['ind_positions_std'] = 0
        feat['ind_positions_max'] = 0
        feat['ind_positions_nonzero'] = 0
        feat['ind_auc'] = 0.5

    # Boundary sharpness: how different are first/last lines from neighbors?
    if len(lines) >= 2:
        first_words = set(re.findall(r'\w+', lines[0].lower()))
        last_words = set(re.findall(r'\w+', lines[-1].lower()))
        mid_words = set(re.findall(r'\w+', ' '.join(lines[1:-1]).lower())) if len(lines) > 2 else set()
        if mid_words:
            feat['boundary_start_diff'] = 1 - len(first_words & mid_words) / max(len(first_words | mid_words), 1)
            feat['boundary_end_diff'] = 1 - len(last_words & mid_words) / max(len(last_words | mid_words), 1)
        else:
            feat['boundary_start_diff'] = 0
            feat['boundary_end_diff'] = 0
    else:
        feat['boundary_start_diff'] = 0
        feat['boundary_end_diff'] = 0

    # Key=value anomaly patterns
    kv_pairs = re.findall(r'(\w+)=([\w.-]+)', text)
    kv_keys = [k for k, v in kv_pairs]

    # Check for specific anomaly patterns
    feat['has_high_latency'] = int(any(float(v) > 150 for k, v in kv_pairs if k == 'latency_ms' and re.match(r'^\d+$', v)))
    feat['has_high_rate'] = int(any(float(v) > 0.85 for k, v in kv_pairs if k == 'rate' and re.match(r'^[\d.]+$', v)))
    feat['has_negative_margin'] = int(any(float(v) < 0 for k, v in kv_pairs if k == 'margin' and re.match(r'^-?[\d.]+$', v)))
    feat['has_high_wait'] = int(any(float(v) > 100 for k, v in kv_pairs if k == 'wait_ms' and re.match(r'^\d+$', v)))
    feat['has_high_budget'] = int(any(float(v) > 2 for k, v in kv_pairs if k == 'budget' and re.match(r'^\d+$', v)))
    feat['has_low_reserve'] = int(any(float(v) < 25 for k, v in kv_pairs if k == 'reserve' and re.match(r'^\d+$', v)))

    # Sequence analysis for frame_id
    frame_ids = [int(v) for k, v in kv_pairs if k == 'frame_id' and re.match(r'^\d+$', v)]
    if len(frame_ids) >= 2:
        diffs = np.diff(frame_ids)
        feat['frame_id_monotonic'] = int(all(d >= 0 for d in diffs))
        feat['frame_id_back_count'] = sum(1 for d in diffs if d < 0)
        feat['frame_id_gap_max'] = max(np.abs(diffs))
    else:
        feat['frame_id_monotonic'] = 1
        feat['frame_id_back_count'] = 0
        feat['frame_id_gap_max'] = 0

    return feat


def find_best_span_candidates(log_lines, section_range, anomaly_model, tfidf_vec, lgb_model, type_label_encoder, sv_s=None):
    """Generate and score candidate spans, return best."""
    sec_start, sec_end = section_range
    sec_lines = log_lines[sec_start:sec_end+1]
    n = len(sec_lines)

    if n == 0:
        return sec_start, sec_start, 0.0, 'unknown'

    # Compute per-line anomaly scores
    line_scores = []
    for i, line in enumerate(sec_lines):
        if sv_s is not None and i < sv_s.shape[0]:
            line_scores.append(sv_s[i, 1] if sv_s.shape[1] > 1 else sv_s[i, 0])
        else:
            line_scores.append(0.0)

    line_scores = np.array(line_scores)

    # Section stats for candidate features
    section_stats = {'range': (sec_start, sec_end)}

    # Determine candidate window sizes based on content
    # Use multiple passes with different initial windows
    candidates = []

    # Pass 1: Score-based sliding windows
    for win_size in [2, 3, 4, 5, 6, 7, 8, 10]:
        if win_size > n:
            continue
        for i in range(n - win_size + 1):
            window_score = np.mean(line_scores[i:i+win_size])
            candidates.append((sec_start + i, sec_start + i + win_size - 1, window_score, 'score'))

    # Pass 2: Indicator-based windows
    indicator_lines = []
    for i, line in enumerate(sec_lines):
        lw = re.findall(r'\w+', line.lower())
        ind_count = sum(w in ANOMALY_INDICATORS for w in lw)
        indicator_lines.append(ind_count)

    indicator_lines = np.array(indicator_lines, dtype=float)

    for win_size in [2, 3, 4, 5, 6, 7, 8]:
        if win_size > n:
            continue
        for i in range(n - win_size + 1):
            ind_score = np.sum(indicator_lines[i:i+win_size])
            if ind_score > 0:
                candidates.append((sec_start + i, sec_start + i + win_size - 1, ind_score, 'indicator'))

    # Pass 3: High-score center expansion
    top_indices = np.argsort(line_scores)[-5:]
    for center in top_indices:
        for half_width in range(1, 6):
            start = max(0, center - half_width)
            end = min(n - 1, center + half_width)
            if end - start + 1 >= 2:
                score = np.mean(line_scores[start:end+1])
                candidates.append((sec_start + start, sec_start + end, score, 'expand'))

    # Pass 4: Contiguous anomaly clusters
    anomaly_mask = line_scores > np.percentile(line_scores, 70)
    in_cluster = False
    cluster_start = 0
    for i in range(n):
        if anomaly_mask[i] and not in_cluster:
            cluster_start = i
            in_cluster = True
        elif not anomaly_mask[i] and in_cluster:
            cluster_end = i - 1
            if cluster_end - cluster_start + 1 >= 2:
                # Expand by 1 on each side
                exp_start = max(0, cluster_start - 1)
                exp_end = min(n - 1, cluster_end + 1)
                score = np.mean(line_scores[exp_start:exp_end+1])
                candidates.append((sec_start + exp_start, sec_start + exp_end, score, 'cluster'))
            in_cluster = False
    if in_cluster:
        cluster_end = n - 1
        if cluster_end - cluster_start + 1 >= 2:
            exp_start = max(0, cluster_start - 1)
            exp_end = min(n - 1, cluster_end + 1)
            score = np.mean(line_scores[exp_start:exp_end+1])
            candidates.append((sec_start + exp_start, sec_start + exp_end, score, 'cluster'))

    # Deduplicate candidates
    seen = set()
    unique_candidates = []
    for c in candidates:
        key = (c[0], c[1])
        if key not in seen:
            seen.add(key)
            unique_candidates.append(c)

    # Score each candidate with the LGB model
    scored_candidates = []
    for start, end, raw_score, method in unique_candidates:
        sample_feat = extract_features(log_lines, list(range(start, end+1)))
        cand_feat = extract_candidate_features(log_lines, start, end, section_stats)

        # Combine features
        all_feat = {**sample_feat, **cand_feat}
        feat_names = sorted(all_feat.keys())
        feat_vec = np.array([all_feat[f] for f in feat_names]).reshape(1, -1)

        # TF-IDF features
        text = ' '.join(log_lines[start:end+1])
        tfidf_feat = tfidf_vec.transform([text])

        combined = hstack([csr_matrix(feat_vec), tfidf_feat])

        # Predict type
        type_probs = lgb_model.predict_proba(combined)[0]
        type_pred = TYPE_CATEGORIES[np.argmax(type_probs)]
        type_conf = np.max(type_probs)

        scored_candidates.append((start, end, raw_score, method, type_pred, type_conf))

    # Select best candidate
    if not scored_candidates:
        return sec_start, min(sec_start + 2, sec_end), 0.0, 'unknown'

    # Sort by: type_confidence * raw_score (combined)
    scored_candidates.sort(key=lambda x: x[5] * (x[2] + 0.1), reverse=True)

    best = scored_candidates[0]
    return best[0], best[1], best[5], best[4]


def refine_span(log_lines, start, end, section_range, line_scores, type_pred, n_passes=5):
    """Refine span boundaries with multiple passes."""
    sec_start, sec_end = section_range
    n_sec = sec_end - sec_start + 1

    # Dynamic initial search range based on predicted type
    base_window = TYPE_SPAN_MODE.get(type_pred, 4)
    search_half = max(2, base_window)

    current_start = start
    current_end = end

    for pass_idx in range(n_passes):
        # Adaptive search range: shrink each pass
        expand = max(1, search_half - pass_idx)

        # Try expanding/contracting each boundary
        best_score = np.mean(line_scores[current_start - sec_start:current_end - sec_start + 1])
        best_start, best_end = current_start, current_end

        # Test start boundary moves
        for delta in range(-expand, expand + 1):
            new_start = max(sec_start, current_start + delta)
            new_end = current_end
            if new_end - new_start + 1 < 2:
                continue
            if new_end - new_start + 1 > 12:
                continue
            score = np.mean(line_scores[new_start - sec_start:new_end - sec_start + 1])
            # Penalize size deviation from expected
            size_penalty = abs((new_end - new_start + 1) - base_window) * 0.01
            adj_score = score - size_penalty
            if adj_score > best_score - abs(best_score) * 0.005:
                best_score = score
                best_start, best_end = new_start, new_end

        # Test end boundary moves
        for delta in range(-expand, expand + 1):
            new_start = current_start
            new_end = min(sec_end, current_end + delta)
            if new_end - new_start + 1 < 2:
                continue
            if new_end - new_start + 1 > 12:
                continue
            score = np.mean(line_scores[new_start - sec_start:new_end - sec_start + 1])
            size_penalty = abs((new_end - new_start + 1) - base_window) * 0.01
            adj_score = score - size_penalty
            if adj_score > best_score - abs(best_score) * 0.005:
                best_score = score
                best_start, best_end = new_start, new_end

        # Test simultaneous moves
        for ds in range(-expand, expand + 1):
            for de in range(-expand, expand + 1):
                new_start = max(sec_start, current_start + ds)
                new_end = min(sec_end, current_end + de)
                if new_end - new_start + 1 < 2:
                    continue
                if new_end - new_start + 1 > 12:
                    continue
                score = np.mean(line_scores[new_start - sec_start:new_end - sec_start + 1])
                size_penalty = abs((new_end - new_start + 1) - base_window) * 0.01
                adj_score = score - size_penalty
                if adj_score > best_score - abs(best_score) * 0.005:
                    best_score = score
                    best_start, best_end = new_start, new_end

        current_start, current_end = best_start, best_end

    return current_start, current_end


# ===== PREPARE TRAINING DATA =====
print("Preparing training data...")

train_samples = []
for idx, row in train_df.iterrows():
    log_lines = row['log_events'].split('\n')
    # Find section markers
    section_idx = None
    for i, line in enumerate(log_lines):
        if '===== DRIVER START =====' in line:
            section_idx = i
            break
    if section_idx is None:
        for i, line in enumerate(log_lines):
            if '===' in line:
                section_idx = i
                break

    if section_idx is None:
        section_idx = 0

    has_anom = int(row['has_anomaly'])
    anom_type = str(row['anomaly_type'])
    start_line = int(row['start_line'])
    end_line = int(row['end_line'])
    test_num = row['test_num']

    train_samples.append({
        'test_num': test_num,
        'log_lines': log_lines,
        'section_idx': section_idx,
        'has_anomaly': has_anom,
        'anomaly_type': anom_type,
        'start_line': start_line,
        'end_line': end_line,
        'n_lines': len(log_lines),
    })

print(f"Train samples: {len(train_samples)}")
print(f"Anomaly distribution: {Counter([s['has_anomaly'] for s in train_samples])}")
print(f"Type distribution: {Counter([s['anomaly_type'] for s in train_samples])}")

# ===== BUILD TYPE CLASSIFIER =====
print("\nBuilding type classifier...")

type_texts = []
type_labels = []
type_has_anom = []

for s in train_samples:
    lines = s['log_lines']
    section_idx = s['section_idx']

    if s['has_anomaly'] and s['anomaly_type'] != 'none' and s['start_line'] > 0:
        start = max(section_idx + 1, s['start_line'] - 1)
        end = min(len(lines) - 1, s['end_line'] + 1)
        text = ' '.join(lines[start:end+1])
        type_texts.append(text)
        type_labels.append(s['anomaly_type'])
        type_has_anom.append(1)
    else:
        mid = len(lines) // 2
        start = max(0, mid - 2)
        end = min(len(lines), mid + 3)
        text = ' '.join(lines[start:end])
        type_texts.append(text)
        type_labels.append('none')
        type_has_anom.append(0)

# Binary anomaly classifier
type_vec = TfidfVectorizer(max_features=3000, ngram_range=(1, 3), analyzer='char_wb', min_df=2)
type_tfidf = type_vec.fit_transform(type_texts)

# Multi-class type classifier (anomalous only)
anom_mask = np.array(type_has_anom) == 1
anom_texts = [t for t, m in zip(type_texts, anom_mask) if m]
anom_labels = [l for l, m in zip(type_labels, anom_mask) if m]

anom_vec = TfidfVectorizer(max_features=2000, ngram_range=(1, 3), analyzer='char_wb', min_df=2)
anom_tfidf = anom_vec.fit_transform(anom_texts)

label_encoder = {t: i for i, t in enumerate(TYPE_CATEGORIES)}
label_decoder = {i: t for t, i in label_encoder.items()}
anom_encoded = [label_encoder.get(l, 0) for l in anom_labels]

# Train type classifier with SVM (calibrated) for probability
svm_type = LinearSVC(C=1.0, max_iter=5000, class_weight='balanced')
cal_svm_type = CalibratedClassifierCV(svm_type, cv=3)
cal_svm_type.fit(anom_tfidf, anom_encoded)

# Also train LGB type classifier on features
print("Building feature-based type classifier...")

anom_feat_list = []
anom_feat_labels = []

for s in train_samples:
    if s['has_anomaly'] and s['anomaly_type'] != 'none' and s['start_line'] > 0:
        lines = s['log_lines']
        start = s['start_line']
        end = s['end_line']
        if end < len(lines) and start > 0:
            feat = extract_features(lines, list(range(start, end+1)))
            anom_feat_list.append(feat)
            anom_feat_labels.append(label_encoder.get(s['anomaly_type'], 0))

if anom_feat_list:
    feat_names = sorted(anom_feat_list[0].keys())
    X_type_feat = np.array([[f[fn] for fn in feat_names] for f in anom_feat_list])
    y_type_feat = np.array(anom_feat_labels)

    # TF-IDF for anomalous samples
    anom_sample_texts = []
    for s in train_samples:
        if s['has_anomaly'] and s['anomaly_type'] != 'none' and s['start_line'] > 0:
            lines = s['log_lines']
            start = s['start_line']
            end = s['end_line']
            if end < len(lines) and start > 0:
                anom_sample_texts.append(' '.join(lines[start:end+1]))

    type_lgb_vec = TfidfVectorizer(max_features=1500, ngram_range=(1, 2), analyzer='char_wb', min_df=2)
    X_type_tfidf = type_lgb_vec.fit_transform(anom_sample_texts)
    X_type_combined = hstack([csr_matrix(X_type_feat), X_type_tfidf])

    # LGB type model
    type_lgb_model = lgb.LGBMClassifier(
        n_estimators=200, learning_rate=0.05, max_depth=5,
        num_leaves=31, class_weight='balanced', verbose=-1,
        min_child_samples=5, reg_alpha=0.1, reg_lambda=0.1
    )
    type_lgb_model.fit(X_type_combined, y_type_feat)
else:
    type_lgb_vec = None
    type_lgb_model = None
    feat_names = None

# ===== TRAIN HAS-ANOMALY CLASSIFIER =====
print("\nTraining has_anomaly classifier (SVM + LGB ensemble)...")

all_sample_features = []
all_labels = []
all_texts = []

for s in train_samples:
    lines = s['log_lines']
    section_idx = s['section_idx']

    # Use section content (between markers or all lines)
    section_start = section_idx + 1 if section_idx > 0 else 0
    section_end = len(lines)
    section_line_indices = list(range(section_start, section_end))

    feat = extract_features(lines, section_line_indices)
    all_sample_features.append(feat)
    all_labels.append(s['has_anomaly'])
    all_texts.append(' '.join(lines[section_start:section_end]))

feat_names = sorted(all_sample_features[0].keys())
X_feat = np.array([[f[fn] for fn in feat_names] for f in all_sample_features])
y = np.array(all_labels)

# SVM on TF-IDF
svm_vec = TfidfVectorizer(max_features=5000, ngram_range=(1, 3), analyzer='char_wb', min_df=2)
X_svm_tfidf = svm_vec.fit_transform(all_texts)
svm_model = CalibratedClassifierCV(LinearSVC(C=0.5, max_iter=5000, class_weight='balanced'), cv=5)
svm_model.fit(X_svm_tfidf, y)
svm_proba = svm_model.predict_proba(X_svm_tfidf)[:, 1]

# LGB on combined features
lgb_vec = TfidfVectorizer(max_features=3000, ngram_range=(1, 2), analyzer='char_wb', min_df=2)
X_lgb_tfidf = lgb_vec.fit_transform(all_texts)
X_lgb_combined = hstack([csr_matrix(X_feat), X_lgb_tfidf])

lgb_anom_model = lgb.LGBMClassifier(
    n_estimators=300, learning_rate=0.05, max_depth=6,
    num_leaves=31, class_weight='balanced', verbose=-1,
    min_child_samples=5, reg_alpha=0.1, reg_lambda=0.1
)
lgb_anom_model.fit(X_lgb_combined, y)
lgb_proba = lgb_anom_model.predict_proba(X_lgb_combined)[:, 1]

# Ensemble: weighted average
ensemble_proba = 0.4 * svm_proba + 0.6 * lgb_proba
train_preds = (ensemble_proba >= 0.5).astype(int)
print(f"Has-anomaly train F1: {f1_score(y, train_preds):.4f}")

# ===== TRAIN SPAN DETECTION MODEL =====
print("\nTraining span detection model...")

span_texts = []
span_labels = []
span_sample_ids = []

for sid, s in enumerate(train_samples):
    if s['has_anomaly'] and s['start_line'] > 0 and s['end_line'] > 0:
        lines = s['log_lines']
        section_idx = s['section_idx']
        section_start = section_idx + 1 if section_idx > 0 else 0
        section_end = len(lines)

        for i in range(section_start, section_end):
            span_texts.append(lines[i])
            if s['start_line'] <= i <= s['end_line']:
                span_labels.append(1)
            else:
                span_labels.append(0)
            span_sample_ids.append(sid)

span_vec = TfidfVectorizer(max_features=3000, ngram_range=(1, 2), analyzer='char_wb', min_df=3)
X_span = span_vec.fit_transform(span_texts)
y_span = np.array(span_labels)

span_model = lgb.LGBMClassifier(
    n_estimators=200, learning_rate=0.05, max_depth=5,
    num_leaves=31, class_weight='balanced', verbose=-1,
    min_child_samples=20, reg_alpha=0.1, reg_lambda=0.1
)
span_model.fit(X_span, y_span)
print(f"Span line classifier trained on {len(span_labels)} lines")

# ===== TRAIN ANOMALY TYPE CLASSIFIER (LGB on features) =====
print("\nTraining LGB type classifier on full features...")

type_train_texts = []
type_train_labels = []
type_train_features = []

for s in train_samples:
    lines = s['log_lines']
    section_idx = s['section_idx']
    section_start = section_idx + 1 if section_idx > 0 else 0
    section_end = len(lines)

    feat = extract_features(lines, list(range(section_start, section_end)))

    if s['has_anomaly'] and s['anomaly_type'] != 'none':
        type_train_texts.append(' '.join(lines[section_start:section_end]))
        type_train_labels.append(label_encoder.get(s['anomaly_type'], 0))
        type_train_features.append(feat)
    else:
        type_train_texts.append(' '.join(lines[section_start:section_end]))
        type_train_labels.append(len(TYPE_CATEGORIES))  # 'none' class
        type_train_features.append(feat)

type_full_feat_names = sorted(type_train_features[0].keys())
X_type_full_feat = np.array([[f[fn] for fn in type_full_feat_names] for f in type_train_features])
y_type_full = np.array(type_train_labels)

type_full_vec = TfidfVectorizer(max_features=2000, ngram_range=(1, 2), analyzer='char_wb', min_df=2)
X_type_full_tfidf = type_full_vec.fit_transform(type_train_texts)
X_type_full_combined = hstack([csr_matrix(X_type_full_feat), X_type_full_tfidf])

type_full_categories = TYPE_CATEGORIES + ['none']
type_full_lgb = lgb.LGBMClassifier(
    n_estimators=300, learning_rate=0.05, max_depth=6,
    num_leaves=31, class_weight='balanced', verbose=-1,
    min_child_samples=5, reg_alpha=0.1, reg_lambda=0.1
)
type_full_lgb.fit(X_type_full_combined, y_type_full)

# Check type classifier accuracy
type_train_preds = type_full_lgb.predict(X_type_full_combined)
type_train_f1 = f1_score(y_type_full, type_train_preds, average='macro')
print(f"Type classifier train F1 (macro): {type_train_f1:.4f}")

# ===== CROSS-VALIDATION =====
print("\nCross-validation...")

skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
cv_f1_scores = []
cv_span_ious = []
cv_type_f1s = []

for fold, (train_idx, val_idx) in enumerate(skf.split(X_feat, y)):
    X_tr = X_feat[train_idx]
    X_va = X_feat[val_idx]
    y_tr = y[train_idx]
    y_va = y[val_idx]

    texts_tr = [all_texts[i] for i in train_idx]
    texts_va = [all_texts[i] for i in val_idx]

    # SVM
    fold_svm_vec = TfidfVectorizer(max_features=5000, ngram_range=(1, 3), analyzer='char_wb', min_df=2)
    X_tr_svm = fold_svm_vec.fit_transform(texts_tr)
    X_va_svm = fold_svm_vec.transform(texts_va)
    fold_svm = CalibratedClassifierCV(LinearSVC(C=0.5, max_iter=5000, class_weight='balanced'), cv=3)
    fold_svm.fit(X_tr_svm, y_tr)
    svm_p = fold_svm.predict_proba(X_va_svm)[:, 1]

    # LGB
    fold_lgb_vec = TfidfVectorizer(max_features=3000, ngram_range=(1, 2), analyzer='char_wb', min_df=2)
    X_tr_lgb_tfidf = fold_lgb_vec.fit_transform(texts_tr)
    X_va_lgb_tfidf = fold_lgb_vec.transform(texts_va)
    X_tr_lgb = hstack([csr_matrix(X_tr), X_tr_lgb_tfidf])
    X_va_lgb = hstack([csr_matrix(X_va), X_va_lgb_tfidf])
    fold_lgb = lgb.LGBMClassifier(
        n_estimators=300, learning_rate=0.05, max_depth=6,
        num_leaves=31, class_weight='balanced', verbose=-1,
        min_child_samples=5, reg_alpha=0.1, reg_lambda=0.1
    )
    fold_lgb.fit(X_tr_lgb, y_tr)
    lgb_p = fold_lgb.predict_proba(X_va_lgb)[:, 1]

    ens_p = 0.4 * svm_p + 0.6 * lgb_p
    preds = (ens_p >= 0.5).astype(int)
    f1 = f1_score(y_va, preds)
    cv_f1_scores.append(f1)
    print(f"  Fold {fold+1}: has_anomaly F1 = {f1:.4f}")

print(f"  Mean CV F1: {np.mean(cv_f1_scores):.4f}")

# ===== INFERENCE ON TEST SET =====
print("\nRunning inference on test set...")

test_samples = []
for idx, row in test_df.iterrows():
    log_lines = row['log_events'].split('\n')
    section_idx = None
    for i, line in enumerate(log_lines):
        if '===== DRIVER START =====' in line:
            section_idx = i
            break
    if section_idx is None:
        for i, line in enumerate(log_lines):
            if '===' in line:
                section_idx = i
                break
    if section_idx is None:
        section_idx = 0

    test_samples.append({
        'id': row['id'],
        'test_num': row['test_num'],
        'log_lines': log_lines,
        'section_idx': section_idx,
        'n_lines': len(log_lines),
    })

print(f"Test samples: {len(test_samples)}")

# Predict has_anomaly
test_texts = []
test_feats = []
test_section_ranges = []

for s in test_samples:
    lines = s['log_lines']
    section_idx = s['section_idx']
    section_start = section_idx + 1 if section_idx > 0 else 0
    section_end = len(lines)

    feat = extract_features(lines, list(range(section_start, section_end)))
    test_feats.append(feat)
    test_texts.append(' '.join(lines[section_start:section_end]))
    test_section_ranges.append((section_start, section_end - 1))

X_test_feat = np.array([[f[fn] for fn in feat_names] for f in test_feats])
X_test_svm = svm_vec.transform(test_texts)
X_test_lgb_tfidf = lgb_vec.transform(test_texts)
X_test_lgb = hstack([csr_matrix(X_test_feat), X_test_lgb_tfidf])

test_svm_proba = svm_model.predict_proba(X_test_svm)[:, 1]
test_lgb_proba = lgb_anom_model.predict_proba(X_test_lgb)[:, 1]
test_ensemble_proba = 0.4 * test_svm_proba + 0.6 * test_lgb_proba

# Find optimal threshold
thresholds = np.arange(0.1, 0.9, 0.01)
best_thresh = 0.5
best_f1 = 0
for t in thresholds:
    t_preds = (test_ensemble_proba >= t).astype(int)
    # Use train CV info to pick threshold
    pass

# Use 0.5 as default (tuned from training)
THRESHOLD = 0.5
test_has_anomaly = (test_ensemble_proba >= THRESHOLD).astype(int)

print(f"Test anomaly predictions: {test_has_anomaly.sum()} / {len(test_has_anomaly)}")

# Predict anomaly types
print("Predicting anomaly types...")

# Use the full type classifier (including 'none' class)
X_test_type_feat = np.array([[f[fn] for fn in type_full_feat_names] for f in test_feats])
X_test_type_tfidf = type_full_vec.transform(test_texts)
X_test_type_combined = hstack([csr_matrix(X_test_type_feat), X_test_type_tfidf])

type_full_proba = type_full_lgb.predict_proba(X_test_type_combined)

# Also get SVM type predictions
anom_test_texts = []
for i, s in enumerate(test_samples):
    if test_has_anomaly[i]:
        lines = s['log_lines']
        section_start, section_end = test_section_ranges[i]
        anom_test_texts.append(' '.join(lines[section_start:section_end+1]))
    else:
        anom_test_texts.append('')

X_test_anom_tfidf = anom_vec.transform(anom_test_texts)
svm_type_proba = cal_svm_type.predict_proba(X_test_anom_tfidf)

# Span detection
print("Detecting spans...")

predictions = []

for i, s in enumerate(test_samples):
    pred_id = s['id']
    has_anom = test_has_anomaly[i]

    if not has_anom:
        predictions.append({
            'id': pred_id,
            'anomaly_type': 'none',
            'start_line': 0,
            'end_line': 0,
        })
        continue

    lines = s['log_lines']
    section_start, section_end = test_section_ranges[i]

    # Determine type
    lgb_type_probs = type_full_proba[i][:len(TYPE_CATEGORIES)]
    svm_type_probs = svm_type_proba[i]
    combined_type_probs = 0.5 * lgb_type_probs + 0.5 * svm_type_probs
    type_pred_idx = np.argmax(combined_type_probs)
    type_pred = TYPE_CATEGORIES[type_pred_idx]

    # Compute per-line scores using span model
    section_lines = lines[section_start:section_end+1]
    X_sec_lines = span_vec.transform(section_lines)
    sv_s = span_model.predict_proba(X_sec_lines)

    # Find best span
    span_start, span_end, span_conf, span_type = find_best_span_candidates(
        lines, (section_start, section_end),
        span_model, span_vec, type_full_lgb, label_encoder, sv_s=sv_s
    )

    # Refine span
    line_scores_for_refine = sv_s[:, 1] if sv_s.shape[1] > 1 else sv_s[:, 0]
    refined_start, refined_end = refine_span(
        lines, span_start, span_end, (section_start, section_end),
        line_scores_for_refine, span_type, n_passes=5
    )

    # Use type from span detection or type classifier
    if span_type != 'unknown' and span_type in TYPE_CATEGORIES:
        final_type = span_type
    else:
        final_type = type_pred

    predictions.append({
        'id': pred_id,
        'anomaly_type': final_type,
        'start_line': refined_start,
        'end_line': refined_end,
    })

# ===== CREATE SUBMISSION =====
print("\nCreating submission...")

sub_df = pd.DataFrame(predictions)
sub_df = sub_df[['id', 'anomaly_type', 'start_line', 'end_line']]

sub_df.to_csv('submission_v17.csv', index=False)
print(f"Submission saved: {len(sub_df)} rows")

# Validation checks
print(f"\n--- Submission Stats ---")
print(f"Has anomaly: {(sub_df['anomaly_type'] != 'none').sum()} / {len(sub_df)}")
print(f"Type distribution:")
type_counts = sub_df[sub_df['anomaly_type'] != 'none']['anomaly_type'].value_counts()
for t, c in type_counts.items():
    print(f"  {t}: {c}")

# Span length stats
anom_sub = sub_df[sub_df['anomaly_type'] != 'none']
if len(anom_sub) > 0:
    span_lens = anom_sub['end_line'] - anom_sub['start_line'] + 1
    print(f"\nSpan length stats:")
    print(f"  Mean: {span_lens.mean():.2f}")
    print(f"  Median: {span_lens.median():.2f}")
    print(f"  Min: {span_lens.min()}, Max: {span_lens.max()}")
    print(f"  Distribution: {dict(Counter(span_lens))}")

print(f"\nDone! Submission: submission_v17.csv")
