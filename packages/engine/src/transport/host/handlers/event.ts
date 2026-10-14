/** Hiện thực subscription event V2 bằng stream EventBus bền vững. @module */
import { EventBus } from "../../../runtime/events/bus"
import { Effect, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"
import { SseTransport } from "../sse"

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventBus.Service
    return handlers.handleRaw("event.subscribe", () =>
      Effect.gen(function* () {
        const connected = {
          id: EventBus.ID.create(),
          type: "server.connected",
          data: {},
        }
        return HttpServerResponse.stream(
          Stream.make(connected).pipe(
            Stream.concat(events.all()),
            Stream.mapEffect((event) => SseTransport.encodeJsonEvent(event)),
            Stream.pipeThroughChannel(Sse.encode()),
            Stream.encodeText,
          ),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)
