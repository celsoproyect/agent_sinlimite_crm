# Sin Limite IA

> CRM de WhatsApp con IA — bandeja compartida, contactos, pipelines de
> ventas, broadcasts y automatizaciones sin código.

[![License: MIT](https://img.shields.io/badge/License-MIT-violet.svg)](./LICENSE)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20Auth-3ecf8e?logo=supabase)](https://supabase.com)

## Qué incluye

- **Bandeja compartida** sobre la API oficial de WhatsApp Business —
  varios agentes en un mismo número, asignación por conversación,
  estados y notas.
- **Contactos + etiquetas + campos personalizados**, importación CSV,
  deduplicación.
- **Pipelines de ventas** (Kanban) con negocios (deals) vinculados a
  conversaciones.
- **Broadcasts** con plantillas aprobadas por Meta, seguimiento de
  entrega/lectura, variables por destinatario.
- **Automatizaciones sin código** — disparadores por mensaje entrante,
  contacto nuevo, palabras clave o calendario; ramas condicionales,
  esperas, etiquetas, webhooks. Editor visual.
- **Asistente de IA** — usa tu propia clave de OpenAI o Anthropic
  (guardada cifrada; sin costo por asiento, tus datos son tuyos).
  Respuestas sugeridas con un clic en la bandeja, más un bot de
  auto-respuesta con límite por conversación y traspaso limpio a un
  humano. Con una **base de conocimiento** (FAQs, políticas, fichas de
  producto) responde con tu propio contenido — búsqueda híbrida
  (texto completo en Postgres, o semántica con pgvector si hay una
  clave de embeddings configurada).
- **Panel en tiempo real** — tiempos de respuesta, volumen diario,
  valor del pipeline, feed de actividad entre módulos.
- **Cuentas de equipo** — invita compañeros por enlace, acceso por rol
  (owner / admin / agent / viewer), transferencia de propiedad. Cada
  instalación está aislada por cuenta, así que una misma bandeja puede
  ser atendida por todo un equipo. El uso individual funciona sin
  configuración extra.
- **Gestión de cuenta** — email, contraseña, avatar, cierre de sesión
  global.
- **API REST pública** (`/api/v1`) con claves de API con alcance y
  revocables — para construir tus propias automatizaciones sobre el
  CRM. Ver [docs/public-api.md](./docs/public-api.md).
- **Servidor MCP** — opera el CRM desde Claude, Cursor y otros
  asistentes de IA vía [Model Context Protocol](https://modelcontextprotocol.io).
  Solo lectura por defecto, escritura opcional. Ver
  [docs/mcp.md](./docs/mcp.md) (servidor en [`mcp-server/`](./mcp-server)).

## Puesta en marcha

```bash
git clone git@github.com:celsoproyect/agent_sinlimite_crm.git
cd wacrm
npm install
cp .env.local.example .env.local   # completa credenciales de Supabase + Meta
npm run dev
```

Abre <http://localhost:3000>. Redirige a `/login` (o a `/dashboard` si
ya hay sesión iniciada).

¿Prefieres contenedores? Ver [docs/docker.md](./docs/docker.md) para el
setup de Dockerfile + Docker Compose.

## Stack

- **App** — Next.js 16 (App Router), React 19, TypeScript, Tailwind v4.
- **Datos** — Supabase (Postgres + Auth + Storage + RLS).
- **WhatsApp** — Meta Cloud API (WhatsApp Business API oficial).

## Seguridad

Cifrado de tokens (AES-256-GCM), RLS en cada tabla, webhooks
verificados por HMAC, CSP, rate limiting. Ver
[`.github/SECURITY.md`](./.github/SECURITY.md).

## Licencia

[MIT](./LICENSE).
