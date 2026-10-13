import type { AppConfig } from "./types.js";

/** 등급/구역 텍스트 점수. 높을수록 우선. */
export function scoreGradeLabel(label: string, config: AppConfig): number {
  const t = label.replace(/\s+/g, " ").trim();
  const lower = t.toLowerCase();

  for (const avoid of config.avoidGrades) {
    if (t.includes(avoid)) return -1000;
  }

  let score = 0;
  config.preferredGrades.forEach((pref, i) => {
    if (t.includes(pref)) {
      score += 100 - i * 3;
    }
  });

  if (t.includes(config.preferHomeSide)) score += 15;
  if (/중앙|홈플레이트|백스톱|테이블/.test(t)) score += 25;
  if (/내야/.test(t)) score += 20;
  if (/1층|하부|로우/.test(t)) score += 8;
  if (/외야/.test(t)) score -= 40;
  if (/시야/.test(t)) score -= 30;
  if (/휠체어|장애인/.test(t)) score -= 50;

  // 숫자 블록이 낮을수록(앞쪽) 약간 가산 — 확실치 않으면 무시
  const block = lower.match(/(?:block|블?록)\s*0*(\d{1,3})/i)?.[1];
  if (block) score += Math.max(0, 20 - Number(block) / 10);

  return score;
}

export function pickBestGradeIndex(
  labels: string[],
  config: AppConfig,
): number {
  let best = -1;
  let bestScore = -Infinity;
  labels.forEach((label, i) => {
    const s = scoreGradeLabel(label, config);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  });
  return bestScore <= -500 ? -1 : best;
}
