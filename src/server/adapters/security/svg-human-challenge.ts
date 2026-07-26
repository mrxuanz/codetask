import { randomInt } from 'node:crypto'
import type { HumanChallenge, HumanChallengeGenerator } from '../../core/application/ports'

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function codeCharacter(): string {
  return CHARSET[randomInt(0, CHARSET.length)] ?? 'A'
}

export class SvgHumanChallengeGenerator implements HumanChallengeGenerator {
  generate(): HumanChallenge {
    const answer = Array.from({ length: 6 }, codeCharacter).join('')
    const characters = [...answer]
      .map((character, index) => {
        const x = 22 + index * 25
        const y = 38 + randomInt(-5, 6)
        const rotation = randomInt(-14, 15)
        return `<text x="${x}" y="${y}" transform="rotate(${rotation} ${x} ${y})">${character}</text>`
      })
      .join('')
    const lines = Array.from({ length: 7 }, () => {
      const x1 = randomInt(0, 180)
      const y1 = randomInt(0, 60)
      const x2 = randomInt(0, 180)
      const y2 = randomInt(0, 60)
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`
    }).join('')
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="60" viewBox="0 0 180 60">` +
      `<rect width="180" height="60" fill="#f8fafc"/>` +
      `<g stroke="#94a3b8" stroke-width="1" opacity=".55">${lines}</g>` +
      `<g fill="#0f172a" font-family="monospace" font-size="27" font-weight="700">${characters}</g>` +
      `</svg>`
    return {
      answer,
      publicPayload: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
    }
  }
}
