export interface DailyTurnStatus {
  allowed: boolean;
  used: number;
  limit: number;
  date: string;
}

export class DailyTurnLimiter {
  private currentDate = '';
  private count = 0;

  constructor(private readonly nowFn: () => Date = () => new Date()) {}

  private utcDateKey(): string {
    return this.nowFn().toISOString().slice(0, 10);
  }

  private rollIfNeeded(): string {
    const today = this.utcDateKey();
    if (this.currentDate !== today) {
      this.currentDate = today;
      this.count = 0;
    }
    return today;
  }

  static parseLimit(raw = process.env.MAX_DAILY_TURNS): number {
    if (raw === undefined || raw.trim() === '') {
      return 1000;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1000;
  }

  getUsage(limit = DailyTurnLimiter.parseLimit()): DailyTurnStatus {
    const date = this.rollIfNeeded();
    return {
      allowed: limit === 0 || this.count < limit,
      used: this.count,
      limit,
      date,
    };
  }

  isLimitReached(limit = DailyTurnLimiter.parseLimit()): boolean {
    if (limit === 0) return false;
    this.rollIfNeeded();
    return this.count >= limit;
  }

  consumeTurn(limit = DailyTurnLimiter.parseLimit()): DailyTurnStatus {
    const date = this.rollIfNeeded();
    if (limit > 0 && this.count >= limit) {
      return { allowed: false, used: this.count, limit, date };
    }
    this.count += 1;
    return { allowed: true, used: this.count, limit, date };
  }
}

export const dailyTurnLimiter = new DailyTurnLimiter();
