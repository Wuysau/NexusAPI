import { handlePlayground } from '@/lib/playground'
export const dynamic = 'force-dynamic'
export async function POST(req: Request) {
  return handlePlayground(req, 'models')
}
