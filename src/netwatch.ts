import type { BrowserContext, Page, Request, Response } from "playwright";
import { log } from "./logger.js";

/** 예매 진입과 관련 있어 보이는 요청 (대기열/게이트/부킹 API). */
export function isBookingRelatedRequest(url: string): boolean {
  const u = url.toLowerCase();
  // 정적 리소스 제외
  if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i.test(u)) {
    return false;
  }
  if (/google|gstatic|facebook|kakao\.com\/(sdk|pixel)|analytics|sentry/i.test(u)) {
    return false;
  }
  return (
    /tickets\.interpark\.com/i.test(u) &&
    (/\/waiting|\/gates\/|\/onestop|\/book|booking|queue|entr|reserve|standby|waitingline|gate/i.test(
      u,
    ) ||
      /\/api\//i.test(u))
  );
}

export type BookingNetState = {
  pending: number;
  started: number;
  finished: number;
  failed: number;
  lastUrl: string;
  sawWaitingNav: boolean;
  dispose: () => void;
};

/**
 * 컨텍스트 단위로 예매 API/네비게이션 감시.
 * pending > 0 이면 "간 것"으로 취급 (재클릭 금지).
 */
export function watchBookingNetwork(context: BrowserContext): BookingNetState {
  const state: BookingNetState = {
    pending: 0,
    started: 0,
    finished: 0,
    failed: 0,
    lastUrl: "",
    sawWaitingNav: false,
    dispose: () => {},
  };

  const onRequest = (req: Request) => {
    const url = req.url();
    if (!isBookingRelatedRequest(url)) return;
    state.pending += 1;
    state.started += 1;
    state.lastUrl = url;
  };
  const onFinish = (req: Request) => {
    if (!isBookingRelatedRequest(req.url())) return;
    state.pending = Math.max(0, state.pending - 1);
    state.finished += 1;
  };
  const onFail = (req: Request) => {
    if (!isBookingRelatedRequest(req.url())) return;
    state.pending = Math.max(0, state.pending - 1);
    state.failed += 1;
  };
  const onResponse = (res: Response) => {
    const url = res.url();
    if (/\/waiting/i.test(url)) state.sawWaitingNav = true;
  };

  context.on("request", onRequest);
  context.on("requestfinished", onFinish);
  context.on("requestfailed", onFail);
  context.on("response", onResponse);

  for (const p of context.pages()) {
    p.on("framenavigated", (frame) => {
      if (frame === p.mainFrame() && /\/waiting|onestop/i.test(frame.url())) {
        state.sawWaitingNav = true;
      }
    });
  }
  context.on("page", (p) => {
    p.on("framenavigated", (frame) => {
      if (frame === p.mainFrame() && /\/waiting|onestop/i.test(frame.url())) {
        state.sawWaitingNav = true;
      }
    });
  });

  state.dispose = () => {
    context.off("request", onRequest);
    context.off("requestfinished", onFinish);
    context.off("requestfailed", onFail);
    context.off("response", onResponse);
  };

  return state;
}

export function requestGone(state: BookingNetState): boolean {
  return (
    state.pending > 0 ||
    state.started > 0 ||
    state.sawWaitingNav
  );
}

export async function pageLooksInFlight(page: Page): Promise<boolean> {
  const url = page.url();
  if (/\/waiting|onestop\/seat/i.test(url)) return true;
  const t = await page.locator("body").innerText({ timeout: 400 }).catch(() => "");
  return /접속 인원이 많아 대기|나의 대기순서|예매 준비가 완료|확인하고\s*예매하기/.test(
    t.slice(0, 800),
  );
}

export function logNet(state: BookingNetState, tag: string) {
  log.info(
    `${tag} net pending=${state.pending} started=${state.started} done=${state.finished} fail=${state.failed} waitingNav=${state.sawWaitingNav}`,
  );
}
