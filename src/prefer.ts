import type { AppConfig } from "./types.js";

/** 우선순위 티어 — 높을수록 먼저 시도 */
export function gradeTier(label: string): number {
  const t = label.replace(/\s+/g, " ").trim();
  // 1티어: 중앙테이블 ≈ 3루 테이블 (동급)
  if (/중앙\s*테이블|중앙테이블/.test(t)) return 3;
  if (/3루/.test(t) && /테이블/.test(t)) return 3;
  // 2티어: 그 외 테이블석
  if (/테이블/.test(t)) return 2;
  // 3티어: 아무 좌석
  return 1;
}

/** 등급/구역 텍스트 점수. 높을수록 우선. */
export function scoreGradeLabel(label: string, config: AppConfig): number {
  const t = label.replace(/\s+/g, " ").trim();
  const lower = t.toLowerCase();

  for (const avoid of config.avoidGrades) {
    if (t.includes(avoid)) return -1000;
  }

  const tier = gradeTier(t);
  let score = tier * 100;

  // preferredGrades 매칭은 같은 티어 안에서만 미세 조정
  config.preferredGrades.forEach((pref, i) => {
    if (t.includes(pref)) {
      score += Math.max(0, 24 - i);
    }
  });

  if (/테이블/.test(t)) {
    const pax = Number(t.match(/\((\d+)\s*인\)/)?.[1] || 0);
    if (pax > 0) {
      if (pax === config.seatCount) score += 40;
      else if (pax === config.seatCount + 1) score += 15;
      else if (pax > config.seatCount + 2) score -= 15;
    }
    if (/미니\s*테이블/.test(t)) score += 5;
  }

  // 1티어끼리는 거의 동등 — 3루/중앙 가산은 약하게만
  if (tier === 3) {
    if (/중앙\s*테이블|중앙테이블/.test(t)) score += 4;
    if (/3루/.test(t)) score += 4;
  } else {
    if (t.includes(config.preferHomeSide)) score += 12;
    if (/중앙|홈플레이트|백스톱/.test(t)) score += 10;
  }

  if (/내야/.test(t)) score += 8;
  if (/1층|하부|로우/.test(t)) score += 6;
  if (/외야/.test(t)) score -= 40;
  if (/시야/.test(t)) score -= 30;
  if (/휠체어|장애인/.test(t)) score -= 50;
  if (/익사이팅/.test(t)) score -= 25;

  const block = lower.match(/(?:block|블?록)\s*0*(\d{1,3})/i)?.[1];
  if (block) score += Math.max(0, 12 - Number(block) / 10);

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
