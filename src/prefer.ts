import type { AppConfig } from "./types.js";

/** 등급/구역 텍스트 점수. 높을수록 우선. 테이블석 중점. */
export function scoreGradeLabel(label: string, config: AppConfig): number {
  const t = label.replace(/\s+/g, " ").trim();
  const lower = t.toLowerCase();

  for (const avoid of config.avoidGrades) {
    if (t.includes(avoid)) return -1000;
  }

  let score = 0;
  config.preferredGrades.forEach((pref, i) => {
    if (t.includes(pref)) {
      score += 120 - i * 4;
    }
  });

  // 테이블석 최우선 (2인 ≈ seatCount 2)
  if (/테이블/.test(t)) {
    score += 80;
    const pax = Number(t.match(/\((\d+)\s*인\)/)?.[1] || 0);
    if (pax > 0) {
      if (pax === config.seatCount) score += 50;
      else if (pax === config.seatCount + 1) score += 20;
      else if (pax > config.seatCount + 2) score -= 15;
    }
    if (/미니\s*테이블/.test(t)) score += 10;
  }

  if (t.includes(config.preferHomeSide)) score += 18;
  if (/중앙|홈플레이트|백스톱/.test(t)) score += 20;
  if (/내야/.test(t)) score += 12;
  if (/1층|하부|로우/.test(t)) score += 8;
  if (/외야/.test(t)) score -= 40;
  if (/시야/.test(t)) score -= 30;
  if (/휠체어|장애인/.test(t)) score -= 50;
  if (/익사이팅/.test(t)) score -= 25;

  const block = lower.match(/(?:block|블?록)\s*0*(\d{1,3})/i)?.[1];
  if (block) score += Math.max(0, 20 - Number(block) / 10);

  return score;
}

/** 라벨 끝의 잔여석 숫자 (예: "3루 테이블석(2인)12" → 12). 없으면 null */
export function parseRemaining(label: string): number | null {
  const m = label.replace(/\s+/g, "").match(/(\d+)\s*$/);
  if (!m) return null;
  // 가격(원)만 있는 경우 제외 — 보통 잔여는 작은 수
  const n = Number(m[1]);
  if (/원/.test(label) && n >= 1000) return null;
  return n;
}

export function pickBestGradeIndex(
  labels: string[],
  config: AppConfig,
): number {
  let best = -1;
  let bestScore = -Infinity;
  labels.forEach((label, i) => {
    const rem = parseRemaining(label);
    if (rem === 0) return;
    let s = scoreGradeLabel(label, config);
    if (rem != null && rem > 0) s += Math.min(30, rem);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  });
  return bestScore <= -500 ? -1 : best;
}
