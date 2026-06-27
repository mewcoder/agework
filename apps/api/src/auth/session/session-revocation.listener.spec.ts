import { describe, it, expect, vi } from "vitest";
import { SessionRevocationListener } from "./session-revocation.listener";
import type { SessionService } from "./session.service";
import {
  UserDeletedEvent,
  UserDisabledEvent,
  UserPasswordResetEvent,
} from "../../users/user.events";

function makeListener() {
  const sessions = {
    revokeAllForUser: vi.fn().mockResolvedValue(undefined),
  };
  const listener = new SessionRevocationListener(
    sessions as unknown as SessionService
  );
  return { listener, sessions };
}

describe("SessionRevocationListener", () => {
  it("revokes all sessions on delete / disable / password-reset", async () => {
    for (const event of [
      new UserDeletedEvent("user-1"),
      new UserDisabledEvent("user-2"),
      new UserPasswordResetEvent("user-3"),
    ]) {
      const { listener, sessions } = makeListener();
      await listener.onSessionsShouldRevoke(event);
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith(event.userId);
    }
  });

  it("swallows revoke failures so the source operation is not affected", async () => {
    const { listener, sessions } = makeListener();
    sessions.revokeAllForUser.mockRejectedValueOnce(new Error("db down"));

    await expect(
      listener.onSessionsShouldRevoke(new UserDisabledEvent("user-1"))
    ).resolves.toBeUndefined();
  });
});
