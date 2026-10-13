export type AppConfig = {
  postseasonUrl: string;
  pollIntervalMs: number;
  seatCount: number;
  requireConsecutive: boolean;
  headless: boolean;
  profileDir: string;
  matchKeywords: string[];
  homeVenueKeywords: string[];
  preferredGrades: string[];
  avoidGrades: string[];
  preferHomeSide: string;
  maxSaleAttempts: number;
  openEarlyMs: number;
};

export type SportsGoods = {
  goodsCode: string;
  goodsName: string;
  placeCode: string;
  placeName: string;
  playDate?: string;
  playTime?: string;
  bookingOpenTime?: string;
  bookingEndTime?: string;
  landingInfo?: string;
  raw?: unknown;
};

export type SelectedSeat = {
  label: string;
  grade?: string;
};
