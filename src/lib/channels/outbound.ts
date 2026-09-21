import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const denied = new BlockList()
for (const cidr of [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
]) {
  const [address, bits] = cidr.split('/')
  denied.addSubnet(address, Number(bits), 'ipv4')
}
for (const cidr of [
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
  '2001:db8::/32',
  '64:ff9b::/96',
  '2002::/16',
]) {
  const [address, bits] = cidr.split('/')
  denied.addSubnet(address, Number(bits), 'ipv6')
}
export function publicDiagnosticAddress(address: string) {
  const family = isIP(address)
  return (
    family !== 0 && !address.toLowerCase().includes('::ffff:') && !denied.check(address, family === 4 ? 'ipv4' : 'ipv6')
  )
}

/** DNS checked at socket lookup, then the checked address is used directly; no proxy or redirects. */
export function diagnosticRequest(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const finish = (status: number, body: Buffer | null) => {
      try {
        resolve(
          new Response(status === 204 || status === 205 || body === null ? null : new Uint8Array(body), { status }),
        )
      } catch {
        reject(new Error('Invalid upstream status'))
      }
    }
    const target = new URL(url),
      request = target.protocol === 'https:' ? httpsRequest : httpRequest
    const req = request(
      target,
      {
        method: 'POST',
        headers,
        signal,
        agent: false,
        lookup: (host, options, callback) => {
          lookup(host, { all: true })
            .then((addresses) => {
              if (!addresses.length || addresses.some((a) => !publicDiagnosticAddress(a.address))) {
                callback(new Error('Destination rejected'), '', 4)
                return
              }
              if (options.all) callback(null, addresses)
              else callback(null, addresses[0].address, addresses[0].family)
            })
            .catch(() => callback(new Error('Destination unavailable'), '', 4))
        },
      },
      (response) => {
        const status = response.statusCode ?? 502
        if (status < 200 || status >= 300) {
          response.resume()
          finish(status, null)
          return
        }
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 64 * 1024) {
            req.destroy(new Error('Response too large'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => finish(status, Buffer.concat(chunks)))
        response.on('error', () => reject(new Error('Response unavailable')))
      },
    )
    req.on('error', () => reject(new Error('Connection unavailable')))
    req.end(body)
  })
}
