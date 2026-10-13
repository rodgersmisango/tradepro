import type { DerivWS } from './deriv-ws';

/**
 * In-process channel for connection-wide `{ forget_all: <family> }` cancellations.
 *
 * `forget_all` is the only way to clear a colliding subscription whose id the
 * server never handed us — an `AlreadySubscribed` rejection carries no id. But it
 * is blind: one `DerivWS` is shared by every consumer, so it cancels *every*
 * stream in that family on that connection, including streams the sender does not
 * own. The owners it hits get no error frame and no close event; their
 * subscription simply stops delivering. Nothing on the wire tells them to recover,
 * so a `forget_all` sent by one owner leaves the others with a permanently frozen
 * feed on a healthy socket — the exact failure this repo's tick/quote work exists
 * to eliminate.
 *
 * This channel is the missing signal. An owner announces the family it cleared;
 * every other owner re-takes its own streams in that family. It is deliberately
 * process-local: the parties are React hooks sharing one `DerivWS`, not peers on
 * the wire.
 *
 * **Recovery must never cascade.** A re-subscription triggered by a notification
 * must not itself issue a `forget_all`, or two owners contending for the same
 * family would wake each other indefinitely. Publishers therefore grant their
 * recovery path no family-clear budget, which bounds every collision to a single
 * round: one clear, one wake, one re-take per owner.
 */
export interface StreamFamilyForgottenEvent {
  /** The connection the `forget_all` was sent on. Streams on any other are unaffected. */
  socket: DerivWS;
  /** The cleared stream family, e.g. `ticks` or `candles`. */
  family: string;
}

type StreamFamilyForgottenListener = (event: StreamFamilyForgottenEvent) => void;

/**
 * Identity of a participating owner — typically a stable per-hook-instance ref
 * object. Used to register a listener and, when publishing, to skip the
 * publisher's own listener: the stream it is retrying is re-taken on that retry
 * path, and waking it here would make it discard the subscription it is still
 * establishing. An owner holding *other* streams in the cleared family is
 * therefore responsible for re-taking those itself — the skip covers the
 * retrying stream, not the owner's whole registry.
 */
export type StreamFamilyOwner = object;

const listeners = new Map<StreamFamilyOwner, StreamFamilyForgottenListener>();

/**
 * Listen for family-wide cancellations issued elsewhere in the process.
 * An owner may safely both listen and publish — see `notifyStreamFamilyForgotten`.
 * Returns an unregister function.
 */
export function onStreamFamilyForgotten(
  owner: StreamFamilyOwner,
  listener: StreamFamilyForgottenListener
): () => void {
  listeners.set(owner, listener);
  return () => {
    if (listeners.get(owner) === listener) listeners.delete(owner);
  };
}

/**
 * Announce a `{ forget_all: family }` that the server has *already*
 * acknowledged. Publishing only after the acknowledgement matters: a listener
 * that re-subscribed while the clear was still in flight would have its
 * replacement stream cancelled by the very request that woke it.
 *
 * `origin` is the publisher's own owner token, which is skipped.
 */
export function notifyStreamFamilyForgotten(
  event: StreamFamilyForgottenEvent,
  origin?: StreamFamilyOwner
): void {
  // Snapshot: a listener may re-subscribe synchronously, and a failed
  // re-subscription may unregister it.
  for (const [owner, listener] of [...listeners]) {
    if (owner === origin) continue;
    listener(event);
  }
}
