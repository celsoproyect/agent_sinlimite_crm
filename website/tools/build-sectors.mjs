// Generates the sector pages (website/sectores/*.html) and the sector
// carousel inside website/index.html from the data below.
//
//   node website/tools/build-sectors.mjs
//
// The pages reuse index.html's <style>, header and footer, so a design or
// copy change there reaches every sector page on the next run. The output
// is committed: the nginx image serves it as is, with no build step.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BRAND = 'Agentes Sin Límite'
const SIGNUP = 'https://app.crm.agentesinlimite.com/signup'

const ICONS = {
  clinicas: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/>',
  odontologia: '<path d="M7 3c-2.5 0-4 2-4 4.5 0 3 1.5 4.5 2 7 .5 3 1 6.5 2.5 6.5S9.5 17 12 17s2.5 4 4.5 4 2-3.5 2.5-6.5c.5-2.5 2-4 2-7C21 5 19.5 3 17 3c-2 0-3 1-5 1S9 3 7 3Z"/>',
  fisioterapia: '<circle cx="12" cy="4.5" r="2"/><path d="M12 7v6l-3 7M12 13l3 7M5 10l7-1 7 1"/>',
  salones: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1 20 20M8.1 15.9 20 4"/>',
  spa: '<path d="M12 21c-5 0-9-3-9-8 3 0 6 1 9 4 3-3 6-4 9-4 0 5-4 8-9 8Z"/><path d="M12 3c2 2.5 3 5 3 7.5S13.7 15 12 17c-1.7-2-3-4-3-6.5S10 5.5 12 3Z"/>',
  veterinarias: '<circle cx="5.5" cy="10" r="2"/><circle cx="9" cy="5.5" r="2"/><circle cx="15" cy="5.5" r="2"/><circle cx="18.5" cy="10" r="2"/><path d="M12 11c-3 0-6 4.5-6 7 0 1.7 1.3 2.5 3 2.5 1.2 0 2-.5 3-.5s1.8.5 3 .5c1.7 0 3-.8 3-2.5 0-2.5-3-7-6-7Z"/>',
  gimnasios: '<path d="M6 7v10M18 7v10M3 9.5v5M21 9.5v5M6 12h12"/>',
  restaurantes: '<path d="M7 3v8M4.5 3v5a2.5 2.5 0 0 0 5 0V3M7 11v10M17 21V3c-2.5 1.5-3.5 4-3.5 7.5 0 1.5 1 2.5 3.5 2.5"/>',
  eventos: '<path d="M8 3h8l-1 7a3 3 0 0 1-6 0L8 3ZM12 13v8M8.5 21h7"/>',
  tiendas: '<path d="M5 8h14l-1 13H6L5 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  inmobiliarias: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10M10 20v-6h4v6"/>',
  talleres: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5a1.4 1.4 0 0 0 2 2l5.8-5.8a4 4 0 0 0 5.4-5.4l-2.4 2.4-2-.4-.4-2 2.8-2Z"/>',
}

const PROFESSIONALS = {
  name: 'Profesionales',
  text: 'Agenda propia para cada profesional, especialidades, servicios con su duración, ausencias y pregunta de seguro si aplica. Solo hace falta si atienden varias personas.',
}

// Chat lines: ['in', text] · ['out', text] · ['sys', text]
// · ['slots', [a, b, c], pickedIndex] · ['product', name, detail, price, 'p1' | 'p2']
const SECTORS = [
  {
    slug: 'clinicas',
    name: 'Clínicas y consultorios',
    hook: 'Responde dudas de seguros y horarios, y agenda con el doctor correcto.',
    bubble: '"¿Aceptan Humano? ¿Hay pediatra el sábado?"',
    h1: 'Tu clínica responde a cada paciente, a cualquier hora',
    lede: 'El agente resuelve las dudas de seguros, precios y preparación, ofrece chequeos y servicios, y agenda con el doctor y la especialidad correctos.',
    chat: [
      ['in', '¿Aceptan seguro Humano? ¿Hay pediatra el sábado?'],
      ['out', 'Sí, aceptamos Humano. El Dr. Almonte atiende pediatría el sábado a las 9:00 o a las 11:30. ¿Cuál prefieres?'],
      ['slots', ['9:00', '11:30', 'Otro día'], 1],
      ['in', 'Nombre: Pedro Vargas, 809-555-0188'],
      ['out', 'Listo. Sábado 11:30 con el Dr. Almonte. Tu código es <code>CITA-4C19A0</code>. Recuerda traer tu carnet del seguro.'],
    ],
    pillars: [
      ['Atiende', ['Seguros que aceptan, precios de consultas y estudios', 'Preparación para análisis y procedimientos, desde tus documentos', 'Pasa a recepción los casos que necesitan a una persona']],
      ['Vende', ['Chequeos y paquetes con su precio, desde tu catálogo', 'Registra cada interesado como oportunidad en tu embudo', 'Seguimiento después de la consulta para el control']],
      ['Agenda', ['Cada doctor con su horario y su duración de cita', 'Busca por nombre del doctor o por especialidad', 'Recordatorios con el nombre del doctor y cambios con código']],
    ],
    before: [
      ['Recepción contesta el WhatsApp entre paciente y paciente', 'El agente contesta al instante y recepción atiende en persona'],
      ['Las preguntas de seguros llegan de noche y esperan al día siguiente', 'Se responden en el momento, con tu lista de seguros'],
      ['Pacientes que olvidan su cita', 'Recordatorio automático con el doctor y la hora'],
    ],
    plan: ['Profesional', 'Incluye agenda, recordatorios y embudos.'],
    modules: [PROFESSIONALS],
  },
  {
    slug: 'odontologia',
    name: 'Odontología',
    hook: 'Cotiza tratamientos, explica procedimientos y llena la agenda de cada odontólogo.',
    bubble: '"¿Cuánto cuesta un blanqueamiento?"',
    h1: 'Tu consultorio dental, atendiendo y cotizando sin pausa',
    lede: 'El agente explica tratamientos, envía precios de tu catálogo, recuerda las limpiezas y agenda con el odontólogo indicado.',
    chat: [
      ['in', '¿Cuánto cuesta un blanqueamiento? ¿Duele?'],
      ['out', 'El blanqueamiento en consultorio cuesta RD$9,500 y dura una hora. Es un procedimiento sin dolor; puede dar algo de sensibilidad uno o dos días.'],
      ['product', 'Blanqueamiento', 'Una sesión · 60 min', 'RD$9,500', 'p2'],
      ['in', '¿Tienen para el jueves?'],
      ['out', 'El jueves la Dra. Reyes tiene libre a las 10:00 y a las 4:00 p. m. ¿Cuál te reservo?'],
    ],
    pillars: [
      ['Atiende', ['Explica tratamientos y cuidados con tus documentos', 'Responde formas de pago y planes de financiamiento que ofreces', 'Pasa las urgencias a una persona de inmediato']],
      ['Vende', ['Envía tratamientos con foto y precio', 'Cotiza ortodoncia, blanqueamientos y limpiezas', 'Seguimiento a cotizaciones que no se cerraron']],
      ['Agenda', ['Agenda por odontólogo y por tratamiento, con su duración', 'Recordatorio antes de la cita', 'Mensaje de control después del tratamiento']],
    ],
    before: [
      ['Cotizaciones que se pierden en el chat', 'Cada cotización queda en tu embudo con su valor'],
      ['"Te aviso" y el paciente no vuelve', 'Seguimiento automático a quien no respondió'],
      ['Huecos en la agenda por citas olvidadas', 'Recordatorios y cambios de cita por WhatsApp'],
    ],
    plan: ['Profesional', 'Agenda, recordatorios, embudos y seguimiento.'],
    modules: [PROFESSIONALS],
  },
  {
    slug: 'fisioterapia',
    name: 'Fisioterapia y rehabilitación',
    hook: 'Agenda sesiones, vende paquetes y recuerda cada cita del tratamiento.',
    bubble: '"¿Tienen paquete de 10 sesiones?"',
    h1: 'Más sesiones completadas, menos citas perdidas',
    lede: 'El agente responde dudas sobre las terapias, vende paquetes de sesiones y agenda cada cita con el fisioterapeuta indicado.',
    chat: [
      ['in', 'Buenas, me mandaron terapia para la rodilla. ¿Tienen paquete de sesiones?'],
      ['out', 'Sí. Estos son los más usados para rehabilitación de rodilla:'],
      ['product', 'Paquete 10 sesiones', '45 min cada una', 'RD$14,000', 'p2'],
      ['in', 'Ese. ¿Puedo empezar el lunes?'],
      ['out', 'El lunes Luis tiene libre a las 8:00 y a las 5:30 p. m. ¿Cuál te queda mejor?'],
    ],
    pillars: [
      ['Atiende', ['Qué tratan, qué llevar y cuánto dura cada sesión', 'Seguros y formas de pago aceptados', 'Pasa los casos clínicos al fisioterapeuta']],
      ['Vende', ['Paquetes de sesiones con su precio', 'Registra la venta en tu embudo', 'Recupera a quien dejó el tratamiento a medias']],
      ['Agenda', ['Sesiones con el fisioterapeuta indicado', 'Recordatorio antes de cada sesión', 'Reprogramación por WhatsApp con código']],
    ],
    before: [
      ['Pacientes que abandonan el tratamiento', 'Recordatorios y seguimiento a quien deja de venir'],
      ['Llamadas para mover sesiones', 'El paciente cambia su cita por WhatsApp'],
      ['Paquetes que se venden solo en persona', 'El agente los ofrece y los registra desde el chat'],
    ],
    plan: ['Profesional', 'Agenda, recordatorios y seguimiento.'],
    modules: [PROFESSIONALS],
  },
  {
    slug: 'salones',
    name: 'Salones de belleza y barberías',
    hook: 'Muestra servicios y precios, y reserva con el estilista que el cliente quiere.',
    bubble: '"¿Hay turno con Yeni el viernes?"',
    h1: 'Tu salón reserva turnos mientras tú atiendes',
    lede: 'El agente envía tu lista de servicios con fotos y precios, recomienda y reserva con el estilista o barbero que el cliente pide.',
    chat: [
      ['in', '¿Cuánto cuesta un balayage? ¿Hay turno con Yeni el viernes?'],
      ['out', 'El balayage empieza en RD$6,500 según el largo. Yeni tiene libre el viernes a las 10:00 y a las 2:00 p. m.'],
      ['slots', ['10:00', '2:00 p. m.', 'Otro día'], 0],
      ['in', 'Carla Núñez, 829-555-0110'],
      ['out', 'Listo, Carla. Viernes 10:00 con Yeni. Tu código es <code>CITA-A05D3E</code>.'],
    ],
    pillars: [
      ['Atiende', ['Horarios, ubicación y formas de pago', 'Cuidados antes y después de cada servicio', 'Pasa a una persona las consultas especiales']],
      ['Vende', ['Servicios y productos con foto y precio', 'Tarjetas de regalo y combos', 'Mensaje para que vuelvan cuando toca el próximo servicio']],
      ['Agenda', ['Turnos por estilista o barbero, con la duración de cada servicio', 'Ausencias y días libres de cada uno', 'Recordatorio el día antes']],
    ],
    before: [
      ['El teléfono suena mientras tienes las manos ocupadas', 'El agente reserva y tú sigues con tu cliente'],
      ['Clientes que preguntan el precio y no reservan', 'Reciben foto, precio y horarios libres en el mismo chat'],
      ['Turnos vacíos por olvidos', 'Recordatorio automático un día antes'],
    ],
    plan: ['Profesional', 'Agenda, recordatorios y automatizaciones.'],
    modules: [PROFESSIONALS],
  },
  {
    slug: 'spa',
    name: 'Spa y estética',
    hook: 'Explica tratamientos, vende tarjetas de regalo y reserva cabina.',
    bubble: '"¿Tienen tarjetas de regalo?"',
    h1: 'Tu spa vende y reserva, incluso de noche',
    lede: 'El agente explica cada tratamiento, vende paquetes y tarjetas de regalo con tu catálogo, y reserva con la terapeuta disponible.',
    chat: [
      ['in', '¿Qué tarjetas de regalo tienen? Es para mi mamá'],
      ['out', '¡Qué buen detalle! Estas son las más pedidas:'],
      ['product', 'Día de Spa', 'Masaje + facial + almuerzo', 'RD$4,500', 'p1'],
      ['in', 'Esa. A nombre de Ana Rosario'],
      ['out', 'Perfecto. Te envío los datos para el pago y la tarjeta sale hoy mismo.'],
      ['sys', 'Oportunidad · Día de Spa · RD$4,500 → Por pagar'],
    ],
    pillars: [
      ['Atiende', ['Qué incluye cada tratamiento y cuánto dura', 'Contraindicaciones y cuidados, desde tus documentos', 'Pasa a una persona las quejas y casos especiales']],
      ['Vende', ['Paquetes y tarjetas de regalo con foto y precio', 'Promociones de temporada', 'Post-venta y mensaje para la próxima visita']],
      ['Agenda', ['Reservas por terapeuta y por tratamiento', 'Recordatorio antes de la cita', 'Cambios y cancelaciones por WhatsApp']],
    ],
    before: [
      ['Las consultas de la noche se responden al otro día', 'Se responden y se venden en el momento'],
      ['Tarjetas de regalo solo en recepción', 'Se venden desde el chat y quedan en tu embudo'],
      ['Clientas que vienen una vez y no vuelven', 'Mensaje automático para la próxima visita'],
    ],
    plan: ['Profesional', 'Agenda, embudos y automatizaciones.'],
    modules: [PROFESSIONALS],
  },
  {
    slug: 'veterinarias',
    name: 'Veterinarias',
    hook: 'Agenda consultas y vacunas, y guarda los datos de cada mascota.',
    bubble: '"Toca la vacuna de Max, ¿hay espacio?"',
    h1: 'Tu veterinaria atiende a cada dueño sin hacerlo esperar',
    lede: 'El agente responde dudas, vende consultas, baños y productos, y agenda vacunas y citas guardando los datos de la mascota.',
    chat: [
      ['in', 'Hola, a Max le toca la vacuna. ¿Hay espacio mañana?'],
      ['out', '¡Hola! Mañana hay espacio a las 9:30 y a las 4:00 p. m. ¿Max es perro o gato, y qué edad tiene?'],
      ['in', 'Perro, 2 años. A las 4'],
      ['out', 'Listo. Mañana 4:00 p. m., vacuna de Max. Tu código es <code>CITA-6F2B90</code>.'],
      ['sys', 'Ficha actualizada · Mascota: Max · Perro · 2 años'],
    ],
    pillars: [
      ['Atiende', ['Horarios, precios y servicios de la clínica', 'Pasa las emergencias a una persona de inmediato', 'Guarda nombre, especie y edad de la mascota en la ficha']],
      ['Vende', ['Baños, peluquería, alimentos y accesorios desde tu catálogo', 'Planes de vacunación con su precio', 'Recordatorios para volver']],
      ['Agenda', ['Consultas, vacunas y peluquería', 'Recordatorio antes de la cita', 'Agenda por veterinario si son varios']],
    ],
    before: [
      ['Dueños que llaman y nadie contesta', 'Respuesta al instante, a cualquier hora'],
      ['Los datos de la mascota en un cuaderno', 'Guardados en la ficha del cliente'],
      ['Vacunas que se pasan de fecha', 'Mensajes de seguimiento para volver'],
    ],
    plan: ['Profesional', 'Agenda, recordatorios y automatizaciones.'],
    modules: [PROFESSIONALS],
  },
  {
    slug: 'gimnasios',
    name: 'Gimnasios y estudios',
    hook: 'Vende membresías, responde horarios y agenda clases de prueba.',
    bubble: '"¿Cuánto cuesta la mensualidad?"',
    h1: 'Convierte cada pregunta en una nueva membresía',
    lede: 'El agente responde horarios y planes, envía tus membresías con precio, agenda clases de prueba y evaluaciones, y da seguimiento a quien no se inscribió.',
    chat: [
      ['in', '¿Cuánto cuesta la mensualidad? ¿Puedo probar primero?'],
      ['out', '¡Claro! Puedes venir a una clase de prueba gratis. Estos son los planes:'],
      ['product', 'Plan mensual', 'Acceso completo + clases', 'RD$2,900', 'p2'],
      ['in', 'Quiero probar el martes en la mañana'],
      ['out', 'El martes tengo libre a las 7:00 y a las 9:00 a. m. para tu clase de prueba. ¿Cuál prefieres?'],
    ],
    pillars: [
      ['Atiende', ['Horarios, clases, ubicación y parqueo', 'Políticas de congelamiento y pagos', 'Pasa a una persona los casos especiales']],
      ['Vende', ['Membresías y planes con su precio', 'Registra cada interesado en tu embudo', 'Seguimiento a quien vino a probar y no se inscribió']],
      ['Agenda', ['Clases de prueba y evaluaciones', 'Sesiones con entrenador personal', 'Recordatorio antes de la cita']],
    ],
    before: [
      ['Interesados que preguntan y no vuelven', 'Seguimiento automático hasta que se inscriben o dicen que no'],
      ['Precios enviados a mano, uno por uno', 'El agente envía tus planes al instante'],
      ['Clases de prueba sin control', 'Agendadas, con recordatorio, y visibles en el CRM'],
    ],
    plan: ['Profesional', 'Embudos, agenda y automatizaciones.'],
    modules: [],
  },
  {
    slug: 'restaurantes',
    name: 'Restaurantes',
    hook: 'Responde el menú, reserva mesas y maneja la lista de espera.',
    bubble: '"Mesa para 8 el viernes a las 8"',
    h1: 'Reservas, menú y dudas, resueltos por WhatsApp',
    lede: 'El agente responde preguntas del menú y del local, ofrece paquetes para grupos y reserva mesas sabiendo cuántas tienes y para cuántas personas es cada una.',
    chat: [
      ['in', 'Mesa para 8 el viernes a las 8 de la noche'],
      ['out', 'Para 8 personas tendría que unir dos mesas de la terraza. ¿Les parece bien así, o prefieren dos mesas separadas?'],
      ['in', 'Unidas está perfecto'],
      ['out', 'Reservado: viernes 8:00 p. m., 8 personas. Tu código es <code>RES-9E03D7</code>.'],
    ],
    pillars: [
      ['Atiende', ['Menú, opciones vegetarianas y alergias, desde tu carta', 'Horario, ubicación, parqueo y formas de pago', 'Pasa a una persona las quejas y pedidos especiales']],
      ['Vende', ['Envía platos y paquetes para grupos con foto y precio', 'Pre-orden para grupos, si la activas', 'Mensaje de agradecimiento después de la visita']],
      ['Reserva', ['Mesas por capacidad y zona, con duración de turno', 'Pregunta antes de unir mesas', 'Lista de espera y control de clientes que no llegan']],
    ],
    before: [
      ['Alguien pegado al teléfono el viernes en la noche', 'Las reservas llegan solas por WhatsApp'],
      ['Mesas reservadas que nadie ocupa', 'Recordatorio el mismo día y registro de no-shows'],
      ['"¿Tienen opción sin gluten?" sin respuesta', 'El agente responde con tu carta'],
    ],
    plan: ['Profesional', 'Recordatorios, reportes y automatizaciones.'],
    modules: [{ name: 'Restaurante', text: 'Mesas, áreas, unión de mesas, lista de espera, pre-orden y ocupación.' }],
  },
  {
    slug: 'eventos',
    name: 'Salones de eventos',
    hook: 'Cotiza paquetes, bloquea fechas y da seguimiento hasta el depósito.',
    bubble: '"Cumpleaños de 60 personas en noviembre"',
    h1: 'De la primera pregunta al depósito, sin perder una cotización',
    lede: 'El agente responde capacidad y qué incluye cada paquete, cotiza por persona, revisa la fecha y lleva cada evento por su embudo hasta confirmarlo.',
    chat: [
      ['in', 'Quiero cotizar un cumpleaños de 60 personas el 14 de noviembre'],
      ['out', 'El Salón Jardín está libre ese día y recibe hasta 80 personas. Este paquete es el más pedido:'],
      ['product', 'Paquete Celebración', 'Salón 5 h + buffet + decoración', 'RD$1,850 p/p', 'p1'],
      ['in', 'Me interesa. A nombre de Laura Medina'],
      ['out', 'Listo, Laura. Tu solicitud es <code>EVT-2A8F51</code>. Para separar la fecha se pide un depósito del 30%.'],
    ],
    pillars: [
      ['Atiende', ['Capacidad, qué incluye cada salón y cada paquete', 'Políticas de depósito y cancelación', 'Pasa a una persona las solicitudes especiales']],
      ['Vende', ['Paquetes con precio fijo o por persona', 'Cada evento avanza: Solicitud, Cotizado, Depósito, Confirmado', 'Seguimiento a cotizaciones sin respuesta']],
      ['Agenda', ['Fechas bloqueadas cuando el salón ya está reservado', 'Aprobación manual y depósito opcionales', 'Recordatorios antes del evento']],
    ],
    before: [
      ['Cotizaciones que se enfrían en el chat', 'Cada una en el embudo, con seguimiento'],
      ['Dos clientes preguntando por la misma fecha', 'El agente ve la fecha ocupada al instante'],
      ['No sabes quién pagó el depósito', 'Visible en la etapa de cada evento'],
    ],
    plan: ['Profesional', 'Embudos, recordatorios y automatizaciones.'],
    modules: [{ name: 'Eventos', text: 'Salones, paquetes, depósito, aprobación y embudo del evento.' }],
  },
  {
    slug: 'tiendas',
    name: 'Tiendas y ventas por WhatsApp',
    hook: 'Envía el catálogo con fotos y precios, recomienda y registra cada venta.',
    bubble: '"¿La tienen en talla M?"',
    h1: 'Tu mejor vendedor contesta en segundos',
    lede: 'El agente responde tallas, envíos y formas de pago, envía tus productos con foto y precio, recomienda y deja cada venta registrada en tu embudo.',
    chat: [
      ['in', '¿Tienen vestidos para una boda? Talla M'],
      ['out', '¡Sí! Estos están disponibles en talla M:'],
      ['product', 'Vestido Marina', 'Largo · Satén · M', 'RD$3,800', 'p1'],
      ['product', 'Vestido Coral', 'Midi · Lino · M', 'RD$2,950', 'p2'],
      ['in', 'Me encanta el Marina. ¿Hacen envíos a Santiago?'],
      ['out', 'Sí, enviamos a todo el país en 24 a 48 horas por RD$250. ¿Te paso los datos para el pago?'],
    ],
    pillars: [
      ['Atiende', ['Tallas, colores, envíos y formas de pago, desde tus documentos', 'Estado del pedido cuando tu equipo lo actualiza', 'Pasa a una persona los reclamos y cambios']],
      ['Vende', ['Envía productos con foto, descripción y precio', 'Recomienda según lo que busca el cliente', 'Registra cada venta con su valor en tu embudo']],
      ['Da seguimiento', ['Post-venta automático a quien compró', 'Recupera a quien preguntó y no compró', 'Reportes de ventas por canal']],
    ],
    before: [
      ['Mandar fotos y precios a mano, cliente por cliente', 'El agente envía tu catálogo al instante'],
      ['Clientes que preguntan y se van con la competencia', 'Respuesta en segundos y seguimiento automático'],
      ['No sabes cuánto vendiste por WhatsApp', 'Cada venta queda en el embudo y en los reportes'],
    ],
    plan: ['Inicial o Profesional', 'Inicial para atender y vender; Profesional si quieres embudos y seguimiento automático.'],
    modules: [],
  },
  {
    slug: 'inmobiliarias',
    name: 'Inmobiliarias',
    hook: 'Envía propiedades, califica al interesado y agenda visitas.',
    bubble: '"¿Tienen apartamentos de 2 habitaciones?"',
    h1: 'Cada interesado atendido, calificado y con visita agendada',
    lede: 'El agente envía propiedades con foto y precio, pregunta lo que necesitas saber del cliente y agenda la visita con el agente inmobiliario.',
    chat: [
      ['in', 'Busco apartamento de 2 habitaciones en Naco, hasta US$180 mil'],
      ['out', 'Tengo estas opciones en Naco dentro de tu presupuesto:'],
      ['product', 'Apto. Naco 2H', '2 hab · 2 baños · 110 m²', 'US$172,000', 'p2'],
      ['in', '¿Puedo verlo el sábado?'],
      ['out', 'Claro. El sábado hay visitas a las 10:00 y a las 12:00. ¿Cuál te queda mejor?'],
    ],
    pillars: [
      ['Atiende', ['Detalles de cada propiedad, desde tus fichas', 'Requisitos, financiamiento y documentos', 'Pasa a tu agente los clientes listos para negociar']],
      ['Vende', ['Propiedades con foto, características y precio', 'Guarda presupuesto, zona y tipo de propiedad en la ficha', 'Cada interesado como oportunidad con su valor']],
      ['Agenda', ['Visitas a las propiedades', 'Recordatorio antes de la visita', 'Seguimiento después de la visita']],
    ],
    before: [
      ['Mensajes de portales que nadie responde a tiempo', 'Respuesta en segundos, con fotos y precio'],
      ['Visitas con curiosos que no califican', 'El agente pregunta presupuesto y zona primero'],
      ['Interesados que se enfrían', 'Seguimiento automático hasta la decisión'],
    ],
    plan: ['Profesional', 'Embudos, agenda y automatizaciones.'],
    modules: [],
  },
  {
    slug: 'talleres',
    name: 'Talleres mecánicos',
    hook: 'Cotiza servicios, agenda la entrada del vehículo y recuerda el mantenimiento.',
    bubble: '"¿Cuánto cuesta el cambio de aceite?"',
    h1: 'Tu taller cotiza y agenda mientras tú trabajas',
    lede: 'El agente responde precios de servicios, agenda la entrada del vehículo y envía recordatorios para el próximo mantenimiento.',
    chat: [
      ['in', '¿Cuánto cuesta el cambio de aceite para un Corolla 2018?'],
      ['out', 'El cambio de aceite sintético con filtro para tu Corolla cuesta RD$3,200 y toma unos 40 minutos.'],
      ['product', 'Cambio de aceite', 'Sintético + filtro', 'RD$3,200', 'p2'],
      ['in', '¿Puedo llevarlo mañana temprano?'],
      ['out', 'Mañana hay espacio a las 8:00 y a las 9:00 a. m. ¿Cuál te reservo?'],
    ],
    pillars: [
      ['Atiende', ['Horarios, ubicación y servicios del taller', 'Garantías y formas de pago', 'Pasa a un mecánico los diagnósticos']],
      ['Vende', ['Servicios con su precio desde tu catálogo', 'Cotizaciones registradas en tu embudo', 'Seguimiento a cotizaciones sin respuesta']],
      ['Agenda', ['Entrada del vehículo por horario', 'Recordatorio el día antes', 'Mensaje para el próximo mantenimiento']],
    ],
    before: [
      ['Llamadas en medio de un trabajo', 'El agente cotiza y agenda por ti'],
      ['Clientes que llegan todos a la misma hora', 'Entradas repartidas en tu agenda'],
      ['Clientes que olvidan el mantenimiento', 'Mensaje de seguimiento para volver'],
    ],
    plan: ['Profesional', 'Agenda, embudos y automatizaciones.'],
    modules: [],
  },
]

// ---------------------------------------------------------------- helpers

const esc = (s) => s.replace(/&(?!\w+;)/g, '&amp;')
const icon = (slug) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[slug]}</svg>`

function chatLine(line) {
  const [kind] = line
  if (kind === 'in') return `<div class="msg in">${line[1]}</div>`
  if (kind === 'out') return `<div class="msg out">${line[1]}<div class="meta"><i class="tk"></i></div></div>`
  if (kind === 'sys') return `<span class="sys-pill">${line[1]}</span>`
  if (kind === 'slots')
    return `<div class="slot-btns">${line[1].map((s, i) => `<span${i === line[2] ? ' class="picked"' : ''}>${s}</span>`).join('')}</div>`
  if (kind === 'product')
    return `<div class="product"><span class="product-img ${line[4]}"></span><b>${line[1]}</b><small>${line[2]}</small><span class="product-price">${line[3]}</span></div>`
  throw new Error(`unknown chat line ${kind}`)
}

function card(s, prefix, imgPrefix) {
  return `<a class="sec-card" href="${prefix}${s.slug}.html">
        <img src="${imgPrefix}img/sectores/${s.slug}.jpg" alt="" width="600" height="750" loading="lazy">
        <span class="sec-cap">
          <span><h3>${esc(s.name)}</h3><small>${esc(s.hook)}</small></span>
          <span class="sec-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>
        </span>
      </a>`
}

// ---------------------------------------------------------------- index carousel

const indexPath = join(ROOT, 'index.html')
let index = readFileSync(indexPath, 'utf8')
const START = '<!-- sectors:start (generated by tools/build-sectors.mjs) -->'
const END = '<!-- sectors:end -->'
const a = index.indexOf(START)
const b = index.indexOf(END)
if (a < 0 || b < 0) throw new Error('sector markers missing in index.html')
index = index.slice(0, a + START.length) + '\n      ' + SECTORS.map((s) => card(s, 'sectores/', '')).join('\n      ') + '\n' + index.slice(b)
writeFileSync(indexPath, index)

// ---------------------------------------------------------------- sector pages

const style = index.match(/<style>[\s\S]*?<\/style>/)[0]
const fonts = index.match(/<link rel="preconnect"[\s\S]*?display=swap">/)[0]
// Header and footer point one level up from sectores/.
const up = (html) =>
  html
    .replace(/href="#([^"]*)"/g, 'href="../index.html#$1"')
    .replace(/href="(privacidad|terminos|cookies|aviso-legal)\.html"/g, 'href="../$1.html"')
    .replace(/href="sectores\//g, 'href="')
    .replace(/src="logo\.png"/g, 'src="../logo.png"')
const header = up(index.match(/<header class="nav">[\s\S]*?<\/header>/)[0])
const footer = up(index.match(/<footer>[\s\S]*?<\/footer>/)[0])

const script = `<script>
(function () {
  var carousel = document.getElementById('carousel');
  document.querySelectorAll('.car-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      carousel.scrollBy({ left: +b.getAttribute('data-dir') * Math.max(280, carousel.clientWidth * 0.8), behavior: 'smooth' });
    });
  });
  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();
})();
</script>`

function page(s) {
  const others = SECTORS.filter((o) => o.slug !== s.slug)
  const modules = s.modules.length
    ? `<ul class="checks">${s.modules.map((m) => `<li><span><b>${m.name}</b> (+$29/mes): ${esc(m.text)}</span></li>`).join('')}</ul>`
    : `<p>No necesitas módulos extra: el agente, el catálogo, la agenda y los embudos ya cubren tu negocio.</p>`
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" type="image/png" href="../mark.png">
<title>${BRAND} para ${esc(s.name.toLowerCase())}</title>
<meta name="description" content="${esc(s.lede)}">
${fonts}
${style}
</head>
<body>
${header}

<main>
<section class="sec-hero">
  <div class="wrap">
    <div class="hero-copy">
      <nav class="crumb" aria-label="Ruta"><a href="../index.html">Inicio</a><span>/</span><a href="../index.html#sectores">Sectores</a><span>/</span><span>${esc(s.name)}</span></nav>
      <span class="sec-ico">${icon(s.slug)}</span>
      <h1>${esc(s.h1)}</h1>
      <p class="lede">${esc(s.lede)}</p>
      <div class="hero-ctas">
        <a class="btn btn-primary" href="${SIGNUP}">Prueba gratis 14 días</a>
        <a class="btn btn-ghost" href="../index.html#demo">Agenda una demo</a>
      </div>
    </div>
    <div class="mini-chat" aria-label="Ejemplo de conversación">
      <span class="mini-label">Ejemplo de conversación</span>
      ${s.chat.map(chatLine).join('\n      ')}
    </div>
  </div>
</section>

<section style="padding-top: 0">
  <div class="wrap">
    <div class="section-head">
      <span class="eyebrow">Qué hace por tu negocio</span>
      <h2>Atiende, vende y ${s.pillars[2][0] === 'Agenda' ? 'agenda' : s.pillars[2][0].toLowerCase()}</h2>
    </div>
    <div class="pillars">
      ${s.pillars
        .map(
          ([title, items], i) => `<article class="pillar${i === 1 ? ' dark' : ''}">
        <span class="pillar-num">0${i + 1}</span>
        <h3>${title}</h3>
        <ul class="checks">${items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>
      </article>`,
        )
        .join('\n      ')}
    </div>
  </div>
</section>

<section style="padding-top: 0">
  <div class="wrap">
    <div class="section-head">
      <span class="eyebrow">Lo que cambia</span>
      <h2>Antes y después de ${BRAND}</h2>
    </div>
    <div class="before-after">
      <div class="ba-row ba-head"><div>Hoy</div><div>Con ${BRAND}</div></div>
      ${s.before.map(([x, y]) => `<div class="ba-row"><div>${esc(x)}</div><div>${esc(y)}</div></div>`).join('\n      ')}
    </div>
  </div>
</section>

<section style="padding-top: 0">
  <div class="wrap">
    <div class="rec">
      <div>
        <span class="eyebrow">Plan recomendado</span>
        <span class="plan-name">${esc(s.plan[0])}</span>
        <p>${esc(s.plan[1])}</p>
        <a class="btn btn-ghost" href="../index.html#precios" style="width: fit-content">Ver precios</a>
      </div>
      <div>
        <span class="eyebrow">Módulos para tu sector</span>
        ${modules}
      </div>
    </div>
  </div>
</section>

<section class="sectors">
  <div class="wrap">
    <div class="sectors-head">
      <div class="section-head">
        <span class="eyebrow">Otros sectores</span>
        <h2>También lo usan</h2>
      </div>
      <div class="car-nav">
        <button class="car-btn" type="button" data-dir="-1" aria-label="Sectores anteriores"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5-7 7 7 7"/></svg></button>
        <button class="car-btn" type="button" data-dir="1" aria-label="Más sectores"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg></button>
      </div>
    </div>
    <div class="carousel" id="carousel" tabindex="0" aria-label="Otros sectores">
      ${others.map((o) => card(o, '', '../')).join('\n      ')}
    </div>
  </div>
</section>

<section style="padding-bottom: 0">
  <div class="wrap">
    <div class="cta-box">
      <div>
        <h2>Pruébalo en tu negocio.</h2>
        <p>14 días gratis. Te ayudamos a configurar el agente con tu información.</p>
      </div>
      <div class="hero-ctas" style="justify-content: flex-end">
        <a class="btn btn-primary" href="${SIGNUP}">Crear mi cuenta gratis</a>
        <a class="btn btn-ghost" href="../index.html#demo" style="color: var(--accent-ink); border-color: color-mix(in srgb, var(--accent-ink) 40%, transparent)">Agendar demo</a>
      </div>
    </div>
  </div>
</section>
</main>

${footer}

${script}
</body>
</html>
`
}

mkdirSync(join(ROOT, 'sectores'), { recursive: true })
for (const s of SECTORS) writeFileSync(join(ROOT, 'sectores', `${s.slug}.html`), page(s))
console.log(`Wrote ${SECTORS.length} sector pages and the index carousel.`)
