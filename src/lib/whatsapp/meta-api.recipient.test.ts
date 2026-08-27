import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendTextMessage } from "./meta-api";

// A BSUID recipient must be sent in `recipient`, with `to` omitted
// entirely — Meta rejects a request carrying a BSUID in `to` with
// (#100) Invalid parameter. See recipientField() in meta-api.ts and
// https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/
let captured: Record<string, unknown> | null = null;

function okFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    captured = init?.body ? JSON.parse(init.body as string) : null;
    return {
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.TEST" }] }),
    } as Response;
  });
}

const BASE = {
  phoneNumberId: "test-phone",
  accessToken: "test-token",
  text: "hello",
} as const;

describe("sendTextMessage — recipient field selection", () => {
  beforeEach(() => {
    captured = null;
    vi.stubGlobal("fetch", okFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses `to` for a phone number recipient", async () => {
    await sendTextMessage({ ...BASE, to: "1234567890" });
    expect(captured?.to).toBe("1234567890");
    expect(captured?.recipient).toBeUndefined();
  });

  it("uses `recipient` (and omits `to`) for a BSUID recipient", async () => {
    await sendTextMessage({ ...BASE, to: "DO.1063619026050293", toIsBsuid: true });
    expect(captured?.recipient).toBe("DO.1063619026050293");
    expect(captured?.to).toBeUndefined();
  });
});
