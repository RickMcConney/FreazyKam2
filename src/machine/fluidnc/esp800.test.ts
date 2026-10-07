import { describe, it, expect } from 'vitest'
import { parseEsp800, wsSessionPath, parseEsp420Wifi } from './esp800'

describe('parseEsp800', () => {
  it('reads the WebSocket port from a WebUI 3 JSON reply, at the root path for synchronous mode', () => {
    const info = parseEsp800(JSON.stringify({
      cmd: '800', status: 'ok',
      data: { FWVersion: '3.9.1', WebCommunication: 'Synchronous', WebSocketPort: '82', HostName: 'fluidnc' },
    }))
    expect(info).toEqual({ wsPort: 82, wsPath: '/', wsProtocol: 'webui-v3', firmware: '3.9.1', hostName: 'fluidnc' })
  })

  it('puts an asynchronous socket at /ws', () => {
    const info = parseEsp800('{"cmd":"800","status":"ok","data":{"WebCommunication":"Asynchronous","WebSocketPort":"80"}}')
    expect(info?.wsPath).toBe('/ws')
  })

  it('refuses a JSON error reply rather than guessing a port', () => {
    expect(parseEsp800('{"cmd":"800","status":"error","data":"no"}')).toBeNull()
  })

  it('reads a WebUI 2 text reply, which wants the arduino subprotocol', () => {
    const info = parseEsp800('FW version: FluidNC v3.7.8 (main-abc) # FW target:grbl-embedded  # FW HW:Direct SD  # primary sd:/sd # secondary sd:none  # authentication:no # webcommunication: Sync: 81 # hostname:fluidnc # axis:3')
    expect(info).toEqual({ wsPort: 81, wsPath: '/', wsProtocol: 'arduino', firmware: 'FluidNC v3.7.8 (main-abc)', hostName: 'fluidnc' })
  })

  it('returns null for a reply with no socket in it', () => {
    expect(parseEsp800('error:3')).toBeNull()
  })
})

describe('wsSessionPath', () => {
  it('asks FluidNC for an independent session, so a WebUI tab in the same browser cannot close our socket', () => {
    expect(wsSessionPath('/')).toBe('/?independent_session=1')
    expect(wsSessionPath('/ws')).toBe('/ws?independent_session=1')
  })

  it('appends to a path that already has a query', () => {
    expect(wsSessionPath('/ws?x=1')).toBe('/ws?x=1&independent_session=1')
  })
})

describe('parseEsp420Wifi', () => {
  // Trimmed from a real FluidNC v4.1.1 reply.
  const reply = JSON.stringify({ cmd: '420', status: 'ok', data: [
    { id: 'Chip ID', value: '43232' }, { id: 'Sleep mode', value: 'Modem' },
    { id: 'Current WiFi Mode', value: 'STA (CC:7B:5C:9A:E0:A8)' }, { id: 'Connected to', value: 'wifi24' },
    { id: 'Signal', value: '74%' }, { id: 'Phy Mode', value: '11n' }, { id: 'Channel', value: '6' },
    { id: 'FW version', value: 'FluidNC v4.1.1' },
  ] })

  it('reads the signal, network and channel', () => {
    expect(parseEsp420Wifi(reply)).toEqual({ signalPct: 74, rssiDbm: -63, ssid: 'wifi24', channel: 6 })
  })

  it("recovers dBm from FluidNC's percentage: 0 % is -100 dBm, 100 % is -50 dBm", () => {
    const at = (v: string) => parseEsp420Wifi(JSON.stringify({ data: [{ id: 'Signal', value: v }] }))!.rssiDbm
    expect(at('0%')).toBe(-100)
    expect(at('100%')).toBe(-50)
  })

  it('returns null with no signal line, or for a reply that is not JSON', () => {
    expect(parseEsp420Wifi(JSON.stringify({ data: [{ id: 'Chip ID', value: '1' }] }))).toBeNull()
    expect(parseEsp420Wifi('Chip ID: 43232')).toBeNull()
  })
})
