# AGENTS.md

Widget embebido de Zoho CRM (ZET) para gestionar los adjuntos de una oportunidad:
muestra campos según el tipo de programa, valida el documento ICFES con un agente
de Zia Agents y sube los archivos a WorkDrive + AWS.

## Estructura

- `app/widget.html` — UI (Bootstrap 5.3.8) y carga de librerías. El orden importa:
  `pdf-parse` y `tesseract.js` (globales) van ANTES de `index.js` (módulo).
- `app/index.js` — entrada del widget: `ZOHO.embeddedApp.on("PageLoad")`, COQL de la
  oportunidad, validación del adjunto y envío.
- `app/global.js` — estado global, llamadas `zrc`, extracción de texto (PDF/OCR),
  cliente del agente de validación, reglas de decisión y `updateDeal`.
- `server/index.js` — Express HTTPS local (puerto 5000, certificado autofirmado) que
  sirve `app/`.
- `dist/*.zip` — paquete de despliegue (contiene solo `app/`). Se arma a mano; no hay
  script de build.
- `AGENTE VALIDADOR ICFES.md` — prompt del agente. **El código NO lo lee**: hay que
  pegarlo en la configuración del agente en Zoho.

## Comandos

- `zet run` → `https://127.0.0.1:5000`. Hay que abrir esa URL y aceptar el
  certificado autofirmado antes de registrar la URL en Zoho.
- No hay test, lint ni typecheck. Verificación de lógica de código tras editar:
  `node --check app/global.js` y `node --check app/index.js`.

## Reglas de dominio que NO se deben romper

- El LLM no es fuente de verdad. `evaluateAgentResponse(raw, { textoDocumento,
  documentoCrm })` aplica DOS verificaciones deterministas (REGLA 4.1 del JSON y
  `aplicarVerificacionLocal`). Nunca aceptar `coincidencia_identidad: true` sin
  comparar dígitos contra `getGlobalDoc()`.
- `agentValidation.status` es la única compuerta del botón Enviar: `pending`,
  `invalid` y `unknown` bloquean; solo `valid` habilita.
- `documento_estudiante: "NO_ENCONTRADO"` = fallo de OCR → `unknown` (ofrece
  "Reintentar validación"), no `invalid`.
- El tipo de prueba lo exige el PROGRAMA, no el campo de archivo:
  `tipoPruebaPorPrograma` (pregrado/técnico → Saber 11; postgrado → Saber Pro).
  Un `EK…` en pregrado o un `AC…`/`VG…` en postgrado es `invalid` aunque el
  código coincida con el del adjunto y con el documento.
- El documento del CRM llega de `Contact_Name.N_mero_de_identificaci_n1`
  (`setGlobalDoc`). Los API names con `_` por tildes son correctos: NO renombrar.
- Solo se valida `inputGroupFile1` (saber11) o `inputGroupFile7` (saberpro): el
  primero visible que tenga archivo. En `tecnico` se muestra saber11 (sí se valida)
  pero NO los campos fecha de aplicación ni número de registro.
- Conexiones ZRC existentes: `workdrive`, `crm_cun`, `gcp_conn`, `zia_agents`.
  No inventar nombres nuevos.

## Validaciones de registro y fecha (instructivo ICFES)

- Flujo progresivo: en `pregrado`/`postgrado` solo se muestran al inicio Número de
  registro y Fecha de aplicación; los archivos aparecen cuando ambos están
  diligenciados (`showFieldsForProgram`). En `tecnico` no se piden.
- Las pruebas Saber solo aceptan **PDF** (`accept="application/pdf,.pdf"`); las
  imágenes se descartan en `validarArchivoPdf`.
- `validarDatosPrueba()` (PASO 1b de `global.js`) aplica, sin LLM:
  - Saber 11: `AC`/`VG` o `CONVENIO + código`, longitud 12–20, año codificado
    (dígitos 3-6 si ≥14; dígitos 4-5 si 12 y dígito 3 ∈ {1,2}; dígitos 3-4 si no),
    año de la fecha = año del código.
  - Saber Pro: `EK` + números de 14–20 o `gradopostumo`; fecha > 14/10/2009.
  - El registro leído del PDF debe coincidir EXACTAMENTE con el diligenciado.
  - La **fecha de presentación/aplicación leída del PDF** (`extraerFechaAplicacion`) debe
    coincidir EXACTAMENTE con la fecha diligenciada. Si no se puede leer la fecha del
    PDF, no se bloquea (no hay comparación).
  - Sin registro legible en el PDF → `unknown` (permite reintentar), no `invalid`.
- El resultado del agente se cachea por archivo (`identidadValidada`); corregir
  registro/fecha recalcula las reglas locales sin volver a llamar al agente.
- El prompt `AGENTE VALIDADOR ICFES.md` incluye TODAS las reglas del instructivo,
  incluidas las que hoy no se pueden evaluar por falta de datos (edad ≥13, fecha
  de grado, periodo de reporte): el prompt ordena no invalidar por ellas.

## Llamada al agente (hardcodeada)

- `ZIAAGENTS_ORG_ID`, `ZIAAGENTS_AGENT_ID`, `ZIAAGENTS_TRIGGER_URL` y
  `ZIAAGENTS_CONNECTION` están en `app/global.js`. El texto viaja en `query`; el body
  NO lleva `attachments`; el token lo inyecta ZRC con `connection: "zia_agents"`.
- Cambiar de agente en Zoho exige actualizar el AGENT_ID aquí y el prompt en Zoho.

## OCR / extracción de texto

- Versiones fijadas: `pdf-parse@2.4.5` y `tesseract.js@5.1.1`. Si se suben, actualizar
  los 3 sitios: `<script>` en `widget.html`, `TESSERACT_WORKER_PATH` /
  `TESSERACT_CORE_PATH` y `PDF_PARSE_WORKER_URL` en `global.js`.
- OCR en 2 pasadas con un ÚNICO worker. La 2ª (binarizada/Otsu) se ejecuta cuando la
  identificación leída no coincide con el CRM, no solo por bajo conteo de dígitos.
- La tolerancia OCR solo normaliza letras a dígitos (O→0, I→1, S→5...); la comparación
  de dígitos es estricta.
- Umbrales en `global.js`: `MIN_CARACTERES_PDF_DIGITAL = 30`,
  `MIN_CARACTERES_OCR = 20`, `MAX_PAGINAS_OCR = 3` (asume que la identificación está
  en las primeras páginas). Texto insuficiente → `unknown`, nunca `invalid`.

## Flujo de envío (efectos externos)

El click de Enviar hace `updateDeal` (fecha y registro), sube a WorkDrive, asocia el
archivo al Deal con la función CRM `link_from_workdrive`, sube a AWS
(`appdocat.cunapp.pro`), ejecuta `ZOHO.CRM.BLUEPRINT.proceed()` y cierra con
`closeReload`. Un fallo de `updateDeal` aborta el envío; los de WorkDrive/AWS solo se
registran en consola.

## Pruebas

- No viven en el repo. La suite ad-hoc está en
  `%LOCALAPPDATA%\Temp\opencode` y `%LOCALAPPDATA%\Temp\opencode\ocr-test`
  (con `pdf-parse`, `tesseract.js`, `sharp`, `jsdom`), y se corre con `node <archivo>.mjs`.
- Para importar `app/global.js` desde Node hay que stubear `globalThis.ZDK`, `zrc`,
  `PdfParse` y `Tesseract` ANTES del import, y usar `.mjs` o un import dinámico
  (`global.js` es ESM pero `package.json` no declara `"type": "module"`).
- `app/index.js` no corre fuera de Zoho: depende de `ZOHO` y `zrc`.
- PDFs reales de ejemplo en `C:\Users\Administrador\Downloads`
  (`saber11.pdf`, `saber_pro.pdf`, `icfes_saber11 (1).pdf`, etc.).

## Convenciones

- Comentarios, mensajes de UI y logs en español; prefijo de logs `[ZET]`.
- `global.js` usa bloques de documentación largos al inicio de cada sección:
  mantenerlos si cambia el flujo.
- `node_modules/` está versionado aunque `.gitignore` lo liste: no borrarlo ni
  re-agregarlo.
- Reconstruir el zip de `dist/` después de tocar `app/`.
