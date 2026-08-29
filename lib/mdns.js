// Announces the PC as "notflix.local" on the local network.
//
// The problem this solves: your router hands your PC a new IP whenever it feels
// like it, and a PWA saved to a phone's home screen remembers the exact address
// it was installed from. When the IP moves, the saved app points at nothing and
// has to be deleted and re-added.
//
// A name fixes that. Phones already know how to look names up on the local
// network without any router configuration - iOS has done it natively for
// years, and Android since 12 - by shouting "who has notflix.local?" to a
// multicast address and waiting for the owner to answer. This is the bit that
// answers. Whatever IP the PC has at the time is what it replies with, so the
// address on the phone never has to change again.
//
// Written against the wire format directly rather than pulling in a Bonjour
// library, because the only thing needed here is "answer A queries for one
// name" - a few dozen lines, versus a dependency for the whole protocol.

const dgram = require("dgram");
const os = require("os");

const MDNS_ADDR = "224.0.0.251";
const MDNS_PORT = 5353;
const TYPE_A = 1;
const TYPE_ANY = 255;
const CLASS_IN = 1;
const CACHE_FLUSH = 0x8000;   // tells listeners to replace, not append
const QU_BIT = 0x8000;        // querier wants a unicast reply
const TTL_SECONDS = 120;

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

function encodeName(name) {
  const parts = String(name).split(".").filter(Boolean);
  const chunks = [];
  for (const part of parts) {
    const b = Buffer.from(part, "utf8");
    chunks.push(Buffer.from([b.length]), b);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

// Returns { name, next }. Handles compression pointers, which a query is
// unlikely to use but a malformed packet might.
function readName(buf, offset) {
  const labels = [];
  let next = offset;
  let jumped = false;
  let guard = 0;

  while (guard++ < 128) {
    if (offset >= buf.length) break;
    const len = buf[offset];
    if (len === 0) {
      offset++;
      if (!jumped) next = offset;
      break;
    }
    if ((len & 0xC0) === 0xC0) {
      if (offset + 1 >= buf.length) break;
      const pointer = ((len & 0x3F) << 8) | buf[offset + 1];
      if (!jumped) next = offset + 2;
      jumped = true;
      offset = pointer;
      continue;
    }
    if (offset + 1 + len > buf.length) break;
    labels.push(buf.toString("utf8", offset + 1, offset + 1 + len));
    offset += 1 + len;
    if (!jumped) next = offset;
  }
  return { name: labels.join("."), next };
}

function parseQuestions(buf) {
  if (buf.length < 12) return [];
  const flags = buf.readUInt16BE(2);
  if (flags & 0x8000) return []; // it is a response, not a query
  const count = buf.readUInt16BE(4);

  const questions = [];
  let offset = 12;
  for (let i = 0; i < count && offset + 4 <= buf.length; i++) {
    const { name, next } = readName(buf, offset);
    offset = next;
    if (offset + 4 > buf.length) break;
    questions.push({
      name,
      type: buf.readUInt16BE(offset),
      qclass: buf.readUInt16BE(offset + 2)
    });
    offset += 4;
  }
  return questions;
}

function buildAnswer(name, ip, ttl) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);          // id: always 0 for mDNS
  header.writeUInt16BE(0x8400, 2);     // response, authoritative
  header.writeUInt16BE(0, 4);          // no questions echoed back
  header.writeUInt16BE(1, 6);          // one answer

  const nameBuf = encodeName(name);
  const rr = Buffer.alloc(10);
  rr.writeUInt16BE(TYPE_A, 0);
  rr.writeUInt16BE(CLASS_IN | CACHE_FLUSH, 2);
  rr.writeUInt32BE(ttl, 4);
  rr.writeUInt16BE(4, 8);              // an IPv4 address is 4 bytes

  const rdata = Buffer.from(ip.split(".").map(n => parseInt(n, 10) & 0xFF));
  return Buffer.concat([header, nameBuf, rr, rdata]);
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      out.push({ address: iface.address, netmask: iface.netmask });
    }
  }
  return out;
}

function sameSubnet(a, b, netmask) {
  const toInt = s => s.split(".").reduce((n, p) => (n << 8) + (parseInt(p, 10) & 0xFF), 0) >>> 0;
  const mask = toInt(netmask);
  return (toInt(a) & mask) === (toInt(b) & mask);
}

// A PC can be on WiFi and Ethernet at once. Answer with the address that is on
// the same network as whoever asked, so the phone gets a route that works.
function bestAddressFor(remote) {
  const addrs = localAddresses();
  if (!addrs.length) return null;
  const match = addrs.find(a => {
    try { return sameSubnet(a.address, remote, a.netmask); }
    catch (_) { return false; }
  });
  return (match || addrs[0]).address;
}

// ---------------------------------------------------------------------------

function start(hostname, onReady) {
  const fqdn = String(hostname).replace(/\.local\.?$/i, "") + ".local";
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  let closed = false;
  let announced = null;

  socket.on("error", (err) => {
    // Port 5353 already taken usually means another responder (Bonjour, shipped
    // with iTunes) owns it. Not fatal - the IP address still works.
    if (!closed) {
      console.log("  (Local name unavailable: " + err.message + ")");
      console.log("  Use the IP address below instead.");
    }
    try { socket.close(); } catch (_) {}
  });

  socket.on("message", (msg, rinfo) => {
    let questions;
    try { questions = parseQuestions(msg); } catch (_) { return; }

    const wanted = questions.find(q =>
      q.name.toLowerCase() === fqdn.toLowerCase() &&
      (q.type === TYPE_A || q.type === TYPE_ANY)
    );
    if (!wanted) return;

    const ip = bestAddressFor(rinfo.address);
    if (!ip) return;

    const answer = buildAnswer(fqdn, ip, TTL_SECONDS);
    if (wanted.qclass & QU_BIT) {
      socket.send(answer, rinfo.port, rinfo.address, () => {});
    } else {
      socket.send(answer, MDNS_PORT, MDNS_ADDR, () => {});
    }
  });

  socket.bind(MDNS_PORT, () => {
    try {
      socket.setMulticastTTL(255);
      socket.setMulticastLoopback(true);
      // Joining per-interface rather than once, so a PC on both WiFi and
      // Ethernet answers on whichever one the phone is using.
      let joined = 0;
      for (const a of localAddresses()) {
        try { socket.addMembership(MDNS_ADDR, a.address); joined++; } catch (_) {}
      }
      if (!joined) socket.addMembership(MDNS_ADDR);
    } catch (err) {
      console.log("  (Local name unavailable: " + err.message + ")");
      return;
    }

    announce();
    // Announced more than once because the first packet can be missed while a
    // phone's WiFi is still settling.
    setTimeout(announce, 1000);
    setTimeout(announce, 4000);
    if (onReady) onReady(fqdn);
  });

  function announce() {
    if (closed) return;
    const addrs = localAddresses();
    if (!addrs.length) return;
    const ip = addrs[0].address;
    announced = ip;
    try {
      socket.send(buildAnswer(fqdn, ip, TTL_SECONDS), MDNS_PORT, MDNS_ADDR, () => {});
    } catch (_) {}
  }

  // If the router hands out a different address, say so immediately rather than
  // letting phones sit on a stale one until the record expires.
  const watcher = setInterval(() => {
    const addrs = localAddresses();
    if (addrs.length && addrs[0].address !== announced) announce();
  }, 30000);
  if (watcher.unref) watcher.unref();

  function stop() {
    closed = true;
    clearInterval(watcher);
    try {
      // TTL 0 is a goodbye: it tells listeners to forget the record now.
      if (announced) socket.send(buildAnswer(fqdn, announced, 0), MDNS_PORT, MDNS_ADDR, () => {
        try { socket.close(); } catch (_) {}
      });
      else socket.close();
    } catch (_) {}
  }

  return { stop, hostname: fqdn };
}

module.exports = { start, localAddresses, encodeName, readName, parseQuestions, buildAnswer };
