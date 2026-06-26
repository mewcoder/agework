import { describe, it, expect, vi } from "vitest";
import { Reflector } from "@nestjs/core";
import { lastValueFrom, of } from "rxjs";
import type { ExecutionContext, CallHandler } from "@nestjs/common";
import { ResponseInterceptor } from "./response.interceptor";

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

function makeCallHandler<T>(data: T): CallHandler<T> {
  return { handle: () => of(data) };
}

describe("ResponseInterceptor", () => {
  it("wraps response in {code, data, message} envelope", async () => {
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

  it("passes through raw when @RawResponse is set", async () => {
    const interceptor = makeInterceptor(true);
    const result = await lastValueFrom(
      interceptor.intercept(makeContext(), makeCallHandler({ raw: true }))
    );
    expect(result).toEqual({ raw: true });
  });
});
