'use client';

import { useCallback, useEffect, useRef } from 'react';
import { isDerivApiError, notifyStreamFamilyForgotten, onStreamFamilyForgotten } from '@deriv/core';
import type { DerivWS, StreamFamilyForgottenEvent } from '@deriv/core';

/**
 * How long a quote stream is kept alive after its last consumer leaves.
 *
 * SmartCharts drives its own asynchronous mount lifecycle, so a remount (a `lg`
 * breakpoint crossing, a route change) can tear down and set up in either order.
 * Lingering covers the teardown-then-setup order — the arriving chart reuses the
 * live stream instead of racing the departing one's `forget` into an
 * `AlreadySubscribed` rejection that would leave it with no feed at all. Long
 * enough to outlast a remount, short enough to release a genuinely abandoned
 * symbol promptly.
 *
 * A remount is *not* served from the linger once the lingering stream is known
 * to be dead — the socket was swapped (a login WS swap, an account switch) or a
 * family-wide cancellation landed mid-window. Such a stream is discarded and a
 * fresh one is opened on the live socket instead.
 */
export const QUOTE_FORGET_LINGER_MS = 500;

export type SmartChartsQuoteCallback = (quote: Record<string, unknown>) => void;

export interface SmartChartsSubscribeParams {
  symbol: string;
  granularity?: number;
  style?: string;
}

export interface SmartChartsGetQuotesParams {
  symbol: string;
  granularity?: number;
  count?: number;
  start?: number;
  end?: number;
}

export interface UseSmartChartsApiReturn {
  getQuotes: (params: SmartChartsGetQuotesParams) => Promise<unknown>;
  subscribeQuotes: (
    params: SmartChartsSubscribeParams,
    callback: SmartChartsQuoteCallback
  ) => () => void;
  /**
   * SmartCharts calls this with the original request and the consumer callback
   * it was subscribed with. When the callback is given only that consumer is
   * released; without one the whole pair is released.
   */
  unsubscribeQuotes: (
    request?: { symbol?: string; granularity?: number },
    callback?: SmartChartsQuoteCallback
  ) => void;
}

/** One live server subscription, shared by every consumer of a symbol/granularity pair. */
interface QuoteStream {
  /**
   * The socket this stream was opened on. A `subscription.id` is scoped to its
   * connection, so a stream is only reusable while that socket is still the
   * live one — see `discardStreamsFor`.
   */
  socket: DerivWS;
  /**
   * The request this stream was opened with, kept so it can be re-opened
   * verbatim if a connection-wide `forget_all` cancels it from under us.
   */
  params: SmartChartsSubscribeParams;
  consumers: Set<SmartChartsQuoteCallback>;
  subscriptionId: string | null;
  unsubscribe: (() => Promise<void>) | null;
  /** Pending cancellation, armed once the last consumer leaves. */
  forgetTimer: ReturnType<typeof setTimeout> | null;
  /** Set when the stream has been released, so a late handshake tidies up. */
  closed: boolean;
  /** True while an open handshake is in flight. */
  opening: boolean;
  /**
   * Set when a family-wide cancellation landed mid-handshake, so whatever that
   * handshake produces is already dead and must be taken again. Deferring keeps
   * a single open attempt in flight per stream — two would race to own
   * `unsubscribe`, and the loser's subscription would never be cancelled.
   */
  clearedWhileOpening: boolean;
}

function quoteKey(symbol: string, granularity?: number): string {
  return `${symbol}-${granularity ?? 0}`;
}

/** Stream family to clear when retaking a colliding subscription. */
function streamFamily(granularity?: number): string {
  return granularity ? 'candles' : 'ticks';
}

export function useSmartChartsApi(ws: DerivWS | null): UseSmartChartsApiReturn {
  const wsRef = useRef<DerivWS | null>(ws);
  const streamsRef = useRef<Map<string, QuoteStream>>(new Map());
  // Stable identity for this hook instance on the family-forget channel, so our
  // own `forget_all` never wakes us.
  const forgetChannelOwner = useRef<object>({});
  // `openStream` announces a family clear and the recovery loop re-opens streams
  // through `openStream`, so the two are mutually recursive. A ref breaks the
  // definition cycle without either depending on the other's identity.
  const recoverStreamsRef = useRef<
    (event: StreamFamilyForgottenEvent, exclude?: QuoteStream) => void
  >(() => {});

  const closeStream = useCallback((key: string, stream: QuoteStream) => {
    stream.closed = true;
    if (stream.forgetTimer) {
      clearTimeout(stream.forgetTimer);
      stream.forgetTimer = null;
    }
    if (streamsRef.current.get(key) === stream) {
      streamsRef.current.delete(key);
    }
    if (stream.unsubscribe) {
      // Sends `{ forget: <id> }` — scoped to this stream, so other consumers of
      // the tick family (notably useTicks) keep theirs.
      void stream.unsubscribe();
      stream.unsubscribe = null;
    }
  }, []);

  const startForgetLinger = useCallback(
    (key: string, stream: QuoteStream) => {
      if (stream.forgetTimer) return;
      stream.forgetTimer = setTimeout(() => {
        stream.forgetTimer = null;
        closeStream(key, stream);
      }, QUOTE_FORGET_LINGER_MS);
    },
    [closeStream]
  );

  /**
   * Retire every stream belonging to a socket that can no longer feed it.
   *
   * A stream is bound to the connection it was opened on: its `subscription.id`
   * means nothing on another socket, and `DerivWS` drops its handler table when
   * the underlying socket closes. Leaving such an entry in the registry would
   * let an arriving chart "reuse" a feed nothing writes to — no `ticks_history`
   * would be sent on the live socket and the spot price would freeze for good,
   * with the entry pinned by its consumers so it could never be released.
   */
  const discardStreamsFor = useCallback(
    (socket: DerivWS | null) => {
      for (const [key, stream] of [...streamsRef.current]) {
        if (stream.socket === socket) closeStream(key, stream);
      }
    },
    [closeStream]
  );

  useEffect(() => {
    const previous = wsRef.current;
    wsRef.current = ws;
    // `useDerivWS` builds a fresh DerivWS on a login WS swap or account switch.
    if (previous !== ws) discardStreamsFor(previous);
  }, [ws, discardStreamsFor]);

  useEffect(() => {
    if (!ws) return;
    // The same instance reconnects in place after a drop, but it clears its
    // subscription handlers on close, so its streams are dead either way.
    return ws.onConnectionStateChange(connected => {
      if (!connected) discardStreamsFor(ws);
    });
  }, [ws, discardStreamsFor]);

  useEffect(() => {
    const streams = streamsRef.current;
    return () => {
      for (const [key, stream] of [...streams]) {
        closeStream(key, stream);
      }
      streams.clear();
    };
  }, [closeStream]);

  const getQuotes = useCallback(
    async ({ symbol, granularity, count, start, end }: SmartChartsGetQuotesParams) => {
      if (!wsRef.current) throw new Error('WebSocket not connected');
      const request: Record<string, unknown> = {
        ticks_history: symbol,
        style: granularity ? 'candles' : 'ticks',
        count: count ?? 1000,
        end: end ? String(end) : 'latest',
        adjust_start_time: 1,
      };
      if (granularity) request.granularity = granularity;
      if (start) request.start = String(start);
      return wsRef.current.send(request);
    },
    []
  );

  /**
   * Open the server stream for a pair and fan every quote out to its consumers.
   * A duplicate-subscription rejection is retried exactly once after clearing
   * the colliding family: bounded, so two rival owners cannot ping-pong, but
   * enough to turn a dead feed back into a live one.
   *
   * `allowFamilyForget` is false when this call *is* the recovery from someone
   * else's family clear — see `recoverStreamsInFamily`.
   */
  const openStream = useCallback(
    async (
      socket: DerivWS,
      key: string,
      stream: QuoteStream,
      { symbol, granularity, style }: SmartChartsSubscribeParams,
      allowFamilyForget = true
    ) => {
      const request: Record<string, unknown> = {
        ticks_history: symbol,
        style: style || granularity ? 'candles' : 'ticks',
        adjust_start_time: 1,
        count: 1,
        end: 'latest',
      };
      if (granularity) request.granularity = granularity;

      const emit = (quote: Record<string, unknown>) => {
        for (const consumer of [...stream.consumers]) {
          consumer(quote);
        }
      };

      const handler = (response: Record<string, unknown>) => {
        if (response.tick) {
          const tick = response.tick as { epoch: number; quote: number };
          emit({
            Date: new Date(tick.epoch * 1000).toISOString(),
            Close: tick.quote,
            tick,
            DT: new Date(tick.epoch * 1000),
          });
        }
        if (response.ohlc) {
          const ohlc = response.ohlc as {
            open_time: number;
            open: string;
            high: string;
            low: string;
            close: string;
          };
          emit({
            Date: new Date(ohlc.open_time * 1000).toISOString(),
            Open: parseFloat(ohlc.open),
            High: parseFloat(ohlc.high),
            Low: parseFloat(ohlc.low),
            Close: parseFloat(ohlc.close),
            ohlc,
            DT: new Date(ohlc.open_time * 1000),
          });
        }
      };

      const subscribeOnceRetried = async (allowClear: boolean) => {
        try {
          return await socket.subscribe(request, handler);
        } catch (err) {
          if (!allowClear) throw err;
          if (!isDerivApiError(err) || err.code !== 'AlreadySubscribed') throw err;
          const family = streamFamily(granularity);
          const cleared = await socket.send({ forget_all: family }).then(
            () => true,
            () => false
          );
          // The clear is connection-wide: it also cancelled streams owned by
          // other consumers, and they get no error frame to notice it by. Tell
          // them, now that it has landed so their replacement is not cancelled
          // by our own request. Only a clear the server actually performed can
          // have done collateral damage.
          if (cleared) {
            // This hook instance can own several streams in the family (one per
            // chart symbol/granularity), and the announcement skips our own
            // listener, so nothing else would revive them. Re-take them here —
            // all but this stream, which the retry below takes care of.
            recoverStreamsRef.current({ socket, family }, stream);
            notifyStreamFamilyForgotten({ socket, family }, forgetChannelOwner.current);
          }
          if (stream.closed) return null;
          return await socket.subscribe(request, handler);
        }
      };

      let allowClear = allowFamilyForget;
      stream.opening = true;
      try {
        for (;;) {
          stream.clearedWhileOpening = false;
          const sub = await subscribeOnceRetried(allowClear);
          if (!sub) return;

          if (stream.closed) {
            void sub.unsubscribe();
            return;
          }
          if (!stream.clearedWhileOpening) {
            stream.subscriptionId = sub.subscriptionId;
            stream.unsubscribe = sub.unsubscribe;
            return;
          }
          // A family clear landed while this handshake was in flight, so what we
          // just opened is already dead. Release the handler slot and take it
          // again — never with a clear of our own, so waking cannot cascade.
          void sub.unsubscribe();
          allowClear = false;
        }
      } catch (err) {
        // Never surfaced to the trader: a dead quote stream is a developer
        // signal, and the chart's own retry is the user-facing remedy.
        console.warn('[useSmartChartsApi] quote subscription failed', {
          symbol,
          granularity,
          code: isDerivApiError(err) ? err.code : undefined,
          msgType: isDerivApiError(err) ? err.msgType : undefined,
          error: err,
        });
        // Retire it properly rather than only dropping the registry entry: a
        // stream left `closed: false` with consumers still in its set reads as
        // live to anything holding a reference to it.
        stream.closed = true;
        stream.consumers.clear();
        if (streamsRef.current.get(key) === stream) {
          streamsRef.current.delete(key);
        }
      } finally {
        stream.opening = false;
        stream.clearedWhileOpening = false;
      }
    },
    []
  );

  /**
   * Another owner on our connection cleared a whole stream family. Our streams
   * in it stopped delivering without an error frame or a close event, so this
   * notification is the only signal to re-take them — otherwise the chart keeps
   * a live consumer wired to a feed nothing writes to and the spot price freezes.
   *
   * The re-open is denied a family clear of its own, so waking cannot cascade.
   *
   * `exclude` is the stream whose own retry issued the clear: it re-takes itself
   * on that path, and waking it here would make it discard and re-open the very
   * subscription it is in the middle of establishing.
   */
  const recoverStreamsInFamily = useCallback(
    (event: StreamFamilyForgottenEvent, exclude?: QuoteStream) => {
      for (const [key, stream] of [...streamsRef.current]) {
        if (stream === exclude) continue;
        if (stream.socket !== event.socket) continue;
        if (streamFamily(stream.params.granularity) !== event.family) continue;
        if (stream.closed) continue;
        if (stream.consumers.size === 0) {
          // Lingering with no consumer: the server-side stream is gone, so it
          // must not survive to be handed to a chart that remounts inside the
          // window — that chart sends no `ticks_history` of its own and would be
          // left wired to a feed nothing writes to, with no error to notice it by.
          closeStream(key, stream);
          continue;
        }
        if (stream.opening) {
          // Mid-handshake: whatever it produces is already dead. Let that
          // attempt finish and take the stream again from inside it, rather than
          // opening a second one in parallel.
          stream.clearedWhileOpening = true;
          continue;
        }
        // The server-side stream is already gone; releasing it here only frees
        // the local handler slot, so nothing can still write into the fan-out.
        // Not awaited: a `forget` for a dead id cannot collide with the
        // replacement, which carries a different id.
        if (stream.unsubscribe) void stream.unsubscribe();
        stream.subscriptionId = null;
        stream.unsubscribe = null;
        void openStream(stream.socket, key, stream, stream.params, false);
      }
    },
    [closeStream, openStream]
  );

  useEffect(() => {
    recoverStreamsRef.current = recoverStreamsInFamily;
    return onStreamFamilyForgotten(forgetChannelOwner.current, recoverStreamsInFamily);
  }, [recoverStreamsInFamily]);

  const releaseConsumer = useCallback(
    (key: string, callback: SmartChartsQuoteCallback) => {
      const stream = streamsRef.current.get(key);
      if (!stream) return;
      stream.consumers.delete(callback);
      if (stream.consumers.size === 0) startForgetLinger(key, stream);
    },
    [startForgetLinger]
  );

  const subscribeQuotes = useCallback(
    (params: SmartChartsSubscribeParams, callback: SmartChartsQuoteCallback): (() => void) => {
      const socket = wsRef.current;
      if (!socket) return () => {};

      const key = quoteKey(params.symbol, params.granularity);
      const existing = streamsRef.current.get(key);

      if (existing && existing.socket === socket) {
        // Reuse the stream and abandon any pending cancellation, so a remount
        // costs no server round-trip and cannot collide with itself.
        if (existing.forgetTimer) {
          clearTimeout(existing.forgetTimer);
          existing.forgetTimer = null;
        }
        existing.consumers.add(callback);
        return () => releaseConsumer(key, callback);
      }

      if (existing) {
        // Opened on a socket that has since been replaced: retire it and open a
        // fresh stream below rather than joining a feed that will never deliver.
        closeStream(key, existing);
      }

      const stream: QuoteStream = {
        socket,
        params,
        consumers: new Set([callback]),
        subscriptionId: null,
        unsubscribe: null,
        forgetTimer: null,
        closed: false,
        opening: false,
        clearedWhileOpening: false,
      };
      streamsRef.current.set(key, stream);
      void openStream(socket, key, stream, params);

      return () => releaseConsumer(key, callback);
    },
    [closeStream, openStream, releaseConsumer]
  );

  const unsubscribeQuotes = useCallback(
    (
      request?: { symbol?: string; granularity?: number },
      callback?: SmartChartsQuoteCallback
    ) => {
      if (!request?.symbol) return;
      const key = quoteKey(request.symbol, request.granularity);

      if (callback) {
        releaseConsumer(key, callback);
        return;
      }

      // No consumer identity: release the pair as a whole.
      const stream = streamsRef.current.get(key);
      if (!stream) return;
      stream.consumers.clear();
      startForgetLinger(key, stream);
    },
    [releaseConsumer, startForgetLinger]
  );

  return {
    getQuotes,
    subscribeQuotes,
    unsubscribeQuotes,
  };
}
