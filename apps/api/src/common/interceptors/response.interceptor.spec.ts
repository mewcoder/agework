import { describe, it, expect, vi } from "vitest";
import { Reflector } from "@nestjs/core";
import { lastValueFrom, of, throwError } from "rxjs";
import type { ExecutionContext, CallHandler } from "@nestjs/common";
import { ResponseInterceptor } from "./response.interceptor";
import { RawResponse } from "../decorators/raw-response.decorator";

function makeInterceptor(isRaw = false) {
  const reflector = new Reflector();
  vi.spyOn(reflector, "getAllAndOverride").mockReturnValue(isRaw);
  return new ResponseInterceptor(reflector);
}

function makeContext(): ExecutionContext {
  return {
    getHandler: () => vi.fn(),
    getClass: () => vi.fn(),
  } as unknown as ExecutionContext;
}

function makeMetadataContext(input: {
  controller: object;
  methodName: string;
}): ExecutionContext {
  const prototype = Object.getPrototypeOf(input.controller) as Record<
    string,
    unknown
  >;
  const handler = prototype[input.methodName];
  if (typeof handler !== "function") {
    throw new Error(`${input.methodName} is not a handler`);
  }
  return {
    getHandler: () => handler,
    getClass: () => input.controller.constructor,
  } as unknown as ExecutionContext;
}

function makeCallHandler<T>(data: T): CallHandler<T> {
  return { handle: () => of(data) };
}

function makeThrowingCallHandler(error: unknown): CallHandler<never> {
  return { handle: () => throwError(() => error) };
}

describe("ResponseInterceptor", () => {
  it("wraps response in {code, data, message} message", async () => {
    const interceptor = makeInterceptor(false);
    const result = await lastValueFrom(
      interceptor.intercept(makeContext(), makeCallHandler({ foo: "bar" }))
    );
    expect(result).toEqual({
      code: 0,
      data: { foo: "bar" },
      message: "ok",
    });
  });

  it("wraps null data as null", async () => {
    const interceptor = makeInterceptor(false);
    const result = await lastValueFrom(
      interceptor.intercept(makeContext(), makeCallHandler(null))
    );
    expect(result).toEqual({ code: 0, data: null, message: "ok" });
  });

  it("wraps undefined data as null", async () => {
    const interceptor = makeInterceptor(false);
    const result = await lastValueFrom(
      interceptor.intercept(makeContext(), makeCallHandler(undefined))
    );
    expect(result).toEqual({ code: 0, data: null, message: "ok" });
  });

  it("preserves falsy but defined response values", async () => {
    const interceptor = makeInterceptor(false);

    await expect(
      lastValueFrom(interceptor.intercept(makeContext(), makeCallHandler(0)))
    ).resolves.toEqual({ code: 0, data: 0, message: "ok" });
    await expect(
      lastValueFrom(interceptor.intercept(makeContext(), makeCallHandler(false)))
    ).resolves.toEqual({ code: 0, data: false, message: "ok" });
    await expect(
      lastValueFrom(interceptor.intercept(makeContext(), makeCallHandler("")))
    ).resolves.toEqual({ code: 0, data: "", message: "ok" });
  });

  it("passes through raw when @RawResponse is set", async () => {
    const interceptor = makeInterceptor(true);
    const result = await lastValueFrom(
      interceptor.intercept(makeContext(), makeCallHandler({ raw: true }))
    );
    expect(result).toEqual({ raw: true });
  });

  it("passes through raw response metadata set on a controller class", async () => {
    @RawResponse()
    class TestController {
      raw() {
        return undefined;
      }
    }
    const interceptor = new ResponseInterceptor(new Reflector());
    const result = await lastValueFrom(
      interceptor.intercept(
        makeMetadataContext({
          controller: new TestController(),
          methodName: "raw",
        }),
        makeCallHandler({ raw: true })
      )
    );

    expect(result).toEqual({ raw: true });
  });

  it("passes through raw response metadata set on a handler", async () => {
    class TestController {
      @RawResponse()
      raw() {
        return undefined;
      }
    }
    const interceptor = new ResponseInterceptor(new Reflector());
    const result = await lastValueFrom(
      interceptor.intercept(
        makeMetadataContext({
          controller: new TestController(),
          methodName: "raw",
        }),
        makeCallHandler({ raw: true })
      )
    );

    expect(result).toEqual({ raw: true });
  });

  it("wraps normal handlers when no raw metadata is present", async () => {
    class TestController {
      normal() {
        return undefined;
      }
    }
    const interceptor = new ResponseInterceptor(new Reflector());
    const result = await lastValueFrom(
      interceptor.intercept(
        makeMetadataContext({
          controller: new TestController(),
          methodName: "normal",
        }),
        makeCallHandler({ ok: true })
      )
    );

    expect(result).toEqual({
      code: 0,
      data: { ok: true },
      message: "ok",
    });
  });

  it("does not swallow or map handler errors", async () => {
    const interceptor = makeInterceptor(false);
    const error = new Error("boom");

    await expect(
      lastValueFrom(
        interceptor.intercept(makeContext(), makeThrowingCallHandler(error))
      )
    ).rejects.toBe(error);
  });
});
