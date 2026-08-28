import { redis } from "./redis";

interface RateLimitOptions {
  key: string;
  limit: number;
  windowSeconds: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

// Fixed-window counter via Redis INCR/EXPIRE — the simplest correct rate
// limiter. ponytail: a fixed window allows a burst of up to 2x the limit
// right at the window boundary (attacker times requests around the reset);
// upgrade to a sliding-window log (Redis sorted set) if that specific abuse
// pattern shows up in practice. Not worth the extra complexity up front.
export async function checkRateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  const redisKey = `ratelimit:${opts.key}`;
  const count = await redis.incr(redisKey);
  if (count === 1) {
    await redis.expire(redisKey, opts.windowSeconds);
  }
  const ttl = await redis.ttl(redisKey);
  return {
    allowed: count <= opts.limit,
    remaining: Math.max(0, opts.limit - count),
    retryAfterSeconds: ttl > 0 ? ttl : opts.windowSeconds,
  };
}
