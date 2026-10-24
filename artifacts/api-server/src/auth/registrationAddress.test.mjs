import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalAddress,
  registrationAddress,
} from "./registrationAddress.js";

function request(headers = {}, remoteAddress = "127.0.0.1") {
  return { socket: { remoteAddress }, header: (name) => headers[name] };
}

test("canonicalizes one IPv4 or IPv6 address and rejects ambiguous values", () => {
  assert.equal(canonicalAddress("192.0.2.1"), "192.0.2.1");
  assert.equal(
    canonicalAddress("2001:0DB8:0000:0000:0000:0000:0000:0001"),
    "2001:db8::1",
  );
  assert.equal(canonicalAddress("::FFFF:192.0.2.1"), "::ffff:c000:201");
  for (const invalid of [
    undefined,
    "",
    " 192.0.2.1",
    "192.0.2.1 ",
    "192.0.2.1:4000",
    "192.0.2.1, 192.0.2.2",
    "[2001:db8::1]",
    "fe80::1%eth0",
    "unknown",
    "999.1.1.1",
  ]) {
    assert.equal(canonicalAddress(invalid), null);
  }
});

test("local registration ignores all caller forwarding headers", () => {
  assert.equal(
    registrationAddress(
      request({
        "cf-connecting-ip": "192.0.2.1",
        "x-forwarded-for": "192.0.2.2",
        "x-real-ip": "192.0.2.3",
        forwarded: "for=192.0.2.4",
      }),
      { production: false, render: true },
    ),
    "127.0.0.1",
  );
});

test("Render public mode uses the overwritten single-IP header, never XFF", () => {
  const options = { production: true, render: true };
  assert.equal(
    registrationAddress(
      request({
        "cf-connecting-ip": "2001:DB8::1",
        "x-forwarded-for": "192.0.2.1, 192.0.2.2",
      }),
      options,
    ),
    "2001:db8::1",
  );
  for (const value of [undefined, "", "192.0.2.1, 192.0.2.2", "invalid"]) {
    assert.equal(
      registrationAddress(
        request({
          "cf-connecting-ip": value,
          "x-forwarded-for": "192.0.2.100",
        }),
        options,
      ),
      null,
    );
  }
  assert.equal(
    registrationAddress(request({ "cf-connecting-ip": "192.0.2.1" }), {
      production: true,
      render: false,
    }),
    null,
  );
});
