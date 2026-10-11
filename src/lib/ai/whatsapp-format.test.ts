import { describe, it, expect } from 'vitest'
import {
  formatPrice,
  parseWhatsAppFormatting,
  productCardCaption,
  toWhatsAppFormatting,
} from './whatsapp-format'

describe('toWhatsAppFormatting', () => {
  it('turns markdown into WhatsApp markup', () => {
    const md = '# Limpieza\n\n\n\n**Precio:** RD$1,500\n- Incluye pulido\n* Revisión\n[Ver](https://x.com)'
    expect(toWhatsAppFormatting(md)).toBe(
      '*Limpieza*\n\n*Precio:* RD$1,500\n• Incluye pulido\n• Revisión\nVer: https://x.com',
    )
  })

  it('leaves WhatsApp markup alone', () => {
    const text = '✅ *¡Cita confirmada!*\n\n📅 *Fecha:* jueves 15'
    expect(toWhatsAppFormatting(text)).toBe(text)
  })
})

describe('formatPrice / productCardCaption', () => {
  it('uses local symbols and grouping', () => {
    expect(formatPrice(15000, 'DOP')).toBe('RD$15,000')
    expect(formatPrice(99.5, 'USD')).toBe('US$99.50')
    expect(productCardCaption('Botox', 15000, 'DOP')).toBe('*Botox*\n💰 RD$15,000')
  })
})

describe('parseWhatsAppFormatting', () => {
  it('splits bold, italic and strike segments', () => {
    const segs = parseWhatsAppFormatting('💰 *Precio:* RD$15 _aprox_ ~antes~')
    expect(segs.filter((s) => s.bold).map((s) => s.text)).toEqual(['Precio:'])
    expect(segs.filter((s) => s.italic).map((s) => s.text)).toEqual(['aprox'])
    expect(segs.filter((s) => s.strike).map((s) => s.text)).toEqual(['antes'])
    expect(segs.map((s) => s.text).join('')).toBe('💰 Precio: RD$15 aprox antes')
  })

  it('ignores lone asterisks and math', () => {
    const segs = parseWhatsAppFormatting('2 * 3 = 6 y snake_case_name')
    expect(segs).toHaveLength(1)
    expect(segs[0].bold || segs[0].italic).toBe(false)
  })
})
