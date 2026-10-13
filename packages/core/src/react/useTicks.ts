'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { isDerivApiError, notifyStreamFamilyForgotten, onStreamFamilyForgotten } from '../ws';
import type { DerivWS, StreamFamilyForgottenEvent } from '../ws';
import type { ActiveSymbol, Tick, TicksHistoryResponse } from '../types';

const DEFAULT_TICK_COUNT = 1000;

/** The stream family a `{ forget_all: … }` must name to cancel our tick stream. */
const TICK_FAMILY = 'ticks';

/**
 * How long to wait for our own `forget` to be acknowledged before subscribing
 * anyway.
 *
 * The wait exists only to stop a re-subscription overtaking its own
 * cancellation, so it must never become unbounded: `DerivWS` drops its pending
 * requests when the socket goes away without settling their promises, so a
 * socket that stalls or closes mid-round-trip leaves the forget unanswered
 * forever. Subscribing a little early risks one `AlreadySubscribed`, which the
 * retry below recovers from; never subscribing at all freezes the price for the
 * component's whole lifetime.
 */
export const FORGET_ACK_TIMEOUT_MS = 1500;

/** A cancellation still in flight, tagged with the connection that carries it. */
interface PendingForget {
  socket: DerivWS;
  acknowledged: Promise<void>;
}

/**
 * Resolve when `promise` settles or when `ms` elapses, whichever comes first.
 * Never rejects.
 */
function settleWithin(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

interface UseTicksReturn {
  currentTick: Tick | null;
  prices: number[];
  pipSize: number;
}

export function useTicks(
  ws: DerivWS | null,
  isConnected: boolean,
  activeSymbol: ActiveSymbol | null,
  tickCount: number = DEFAULT_TICK_COUNT
): UseTicksReturn {
  const pricesRef = useRef<number[]>([]);
  const pipSizeRef = useRef<number>(2);
  const unsubscribeRef = useRef<(() => Promise<void>) | null>(null);
  // The in-flight `forget` from the previous effect run. The next run awaits it
  // so a re-subscription for the same symbol cannot race its own cancellation.
  const pendingForgetRef = useRef<PendingForget | null>(null);
  // Stable identity for this hook instance on the family-forget channel, so our
  // own `forget_all` never wakes us.
  const forgetChannelOwner = useRef<object>({});

  const [currentTick, setCurrentTick] = useState<Tick | null>(null);
  const [prices, setPrices] = useState<number[]>([]);
  const [pipSize, setPipSize] = useState<number>(2);

  const pipSizeFromPip = useCallback((pip: number): number => {
    if (pip >= 1) return 0;
    const str = pip.toString();
    const dotIndex = str.indexOf('.');
    return dotIndex === -1 ? 0 : str.length - dotIndex - 1;
  }, []);

  useEffect(() => {
    if (!ws || !isConnected || !activeSymbol) return;
    const socket = ws;
    const owner = forgetChannelOwner.current;
    const symbol = activeSymbol.underlying_symbol;
    let disposed = false;

    // Cancel the stream this hook created, remembering the round-trip so the
    // next subscription can wait for it. Scoped to our own subscription id —
    // never the whole tick family, which the chart's quote feed also lives in.
    const forgetOwnStream = () => {
      if (!unsubscribeRef.current) return;
      pendingForgetRef.current = { socket, acknowledged: unsubscribeRef.current() };
      unsubscribeRef.current = null;
    };

    forgetOwnStream();

    // Reset refs
    pricesRef.current = [];

    const ps = pipSizeFromPip(activeSymbol.pip_size);
    pipSizeRef.current = ps;

    const onTick = (data: Record<string, unknown>) => {
      const tick = (data as { tick?: Tick }).tick;
      if (!tick) return;

      const tickPs = tick.pip_size ?? pipSizeRef.current;
      if (tick.pip_size && tick.pip_size !== pipSizeRef.current) {
        pipSizeRef.current = tick.pip_size;
      }

      setCurrentTick(tick);

      // Sliding window update
      pricesRef.current = [...pricesRef.current, tick.quote];
      if (pricesRef.current.length > tickCount) {
        pricesRef.current = pricesRef.current.slice(-tickCount);
      }
      setPrices([...pricesRef.current]);
      setPipSize(tickPs);
    };

    const reportFailure = (err: unknown) => {
      // Stream lifecycle failures are a developer concern — this hook never
      // raises a user-facing notification of its own.
      console.warn('[useTicks] tick subscription failed', {
        symbol,
        code: isDerivApiError(err) ? err.code : undefined,
        msgType: isDerivApiError(err) ? err.msgType : undefined,
        error: err,
      });
    };

    /**
     * Subscribe, retrying exactly once when the server says the stream is
     * already taken. A duplicate means another owner (or our own departing
     * instance) holds a tick-family stream for this symbol on this connection;
     * clearing the family and retaking it turns a dead feed into a live one.
     *
     * `forget_all` is connection-wide, so it also kills tick streams owned by
     * other consumers — silently, with no error frame on their side. Once the
     * server has acknowledged the clear we announce it, and those owners re-take
     * their own streams.
     *
     * `allowFamilyForget` is false on the recovery path so that announcement can
     * never cascade: one clear, one wake, one re-take per owner. Two rival
     * owners therefore cannot ping-pong.
     */
    async function subscribeTicks(allowFamilyForget: boolean) {
      try {
        return await socket.subscribe({ ticks: symbol }, onTick);
      } catch (err) {
        if (!allowFamilyForget) throw err;
        if (!isDerivApiError(err) || err.code !== 'AlreadySubscribed') throw err;
        const cleared = await socket.send({ forget_all: TICK_FAMILY }).then(
          () => true,
          () => false
        );
        // Only a clear the server actually performed can have collateral damage.
        if (cleared) notifyStreamFamilyForgotten({ socket, family: TICK_FAMILY }, owner);
        if (disposed) return null;
        return await socket.subscribe({ ticks: symbol }, onTick);
      }
    }

    async function subscribe(allowFamilyForget: boolean) {
      const pending = pendingForgetRef.current;
      if (pending) {
        // Only a cancellation on *this* connection can collide with the requests
        // below. One left in flight on a socket that has since been replaced
        // never will, and waiting on it would strand this run for good.
        if (pending.socket === socket) {
          await settleWithin(pending.acknowledged, FORGET_ACK_TIMEOUT_MS);
        }
        // Clear only our own entry — a later run may have armed a new one.
        if (pendingForgetRef.current === pending) pendingForgetRef.current = null;
        if (disposed) return;
      }

      const historyResponse = await socket.send<TicksHistoryResponse>({
        ticks_history: symbol,
        end: 'latest',
        start: 1,
        count: tickCount,
        style: 'ticks',
      });
      if (disposed) return;

      setPipSize(ps);
      const historyPrices = historyResponse.history?.prices ?? [];
      pricesRef.current = historyPrices;
      setPrices([...historyPrices]);

      const sub = await subscribeTicks(allowFamilyForget);
      if (!sub) return;
      if (disposed) {
        // Established after teardown: cancel it, and record the forget so the
        // next run still waits for it rather than racing this late stream.
        pendingForgetRef.current = { socket, acknowledged: sub.unsubscribe() };
        return;
      }
      unsubscribeRef.current = sub.unsubscribe;
    }

    // Only ever one subscribe attempt at a time: two in flight would race to own
    // `unsubscribeRef`, and the loser's stream would never be cancelled.
    let inFlight: Promise<void> | null = null;
    let recoveryQueued = false;

    const runSubscribe = (allowFamilyForget: boolean) => {
      inFlight = subscribe(allowFamilyForget)
        .catch(reportFailure)
        .finally(() => {
          inFlight = null;
          if (!recoveryQueued || disposed) return;
          recoveryQueued = false;
          recoverStream();
        });
    };

    /**
     * Re-take our stream after another owner cleared the tick family. The server
     * sends no error and no close for that — the stream just stops delivering —
     * so the announcement is the only chance to notice.
     *
     * History is re-fetched too, so the price series has no hole where the
     * stream was down.
     */
    function recoverStream() {
      if (disposed) return;
      // A clear that lands mid-handshake can kill the stream we are still
      // establishing, so the recovery waits for that attempt rather than racing
      // it — and then re-takes whatever it ended up with.
      if (inFlight) {
        recoveryQueued = true;
        return;
      }
      if (unsubscribeRef.current) {
        // The server-side stream is already gone; this only releases the local
        // handler slot. Not awaited — a `forget` for a dead id cannot collide
        // with the new subscription, which carries a different id.
        void unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      runSubscribe(false);
    }

    const onFamilyForgotten = (event: StreamFamilyForgottenEvent) => {
      if (event.socket !== socket || event.family !== TICK_FAMILY) return;
      recoverStream();
    };

    const stopListening = onStreamFamilyForgotten(owner, onFamilyForgotten);

    runSubscribe(true);

    return () => {
      disposed = true;
      stopListening();
      setCurrentTick(null);
      setPrices([]);
      forgetOwnStream();
    };
  }, [ws, isConnected, activeSymbol, tickCount, pipSizeFromPip]);

  return { currentTick, prices, pipSize };
}
