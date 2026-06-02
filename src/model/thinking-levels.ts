/**
 * The reasoning-effort vocabulary a turn may request.
 *
 * Deskmate's own names. Each harness maps them onto whatever its runtime accepts, so a level
 * listed here need not exist verbatim at any provider; `auto` leaves the choice to the harness.
 */
export const THINKING_LEVELS = ["auto", "low", "medium", "high", "xhigh", "max", "ultracode"] as const;
