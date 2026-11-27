# Widget ZET — Gestión de Adjuntos de Oportunidades (Zoho CRM)

Widget embebido de **Zoho CRM (ZET)** para gestionar los adjuntos de una oportunidad
(Deal): muestra los campos según el tipo de programa, valida el documento ICFES con un
agente de **Zia Agents** y sube los archivos a **WorkDrive + AWS**.

## Estructura del repositorio

```
app/
  widget.html       # UI (Bootstrap 5.3.8) y carga de librerías. El orden importa:
                    # pdf-parse y tesseract.js (globales) van ANTES de index.js (módulo).
  index.js          # Entrada del widget: ZOHO.embeddedApp.on("PageLoad"), COQL de la
                    # oportunidad, validación del adjunto y envío.
  global.js         # Estado global, llamadas zrc, extracción de texto (PDF/OCR),
                    # cliente del agente de validación, reglas de decisión y updateDeal.
  translations/en.json
server/
  index.js          # Express HTTPS local (puerto 5000, certificado autofirmado) que sirve app/.
dist/
  gestion_adjuntos_opps.zip   # Paquete de despliegue (contiene solo app/).
AGENTE VALIDADOR ICFES.md     # Prompt del agente (pegar en Zoho; el código NO lo lee).
AGENTS.md                     # Reglas de dominio y convenciones para agentes.
```

## Comandos

- `zet run` → `https://127.0.0.1:5000`. Hay que abrir esa URL y aceptar el
  certificado autofirmado antes de registrar la URL en Zoho.
- Verificación de sintaxis tras editar: `node --check app/global.js` y
  `node --check app/index.js`.
- No hay test, lint ni typecheck en el repo. La suite ad-hoc vive en
  `%LOCALAPPDATA%\Temp\opencode` y `%LOCALAPPDATA%\Temp\opencode\ocr-test`.

## Flujo de validación

1. `extraerTextoDocumento(file)` extrae el texto del adjunto (pdf-parse para PDF
   digital; tesseract.js para PDF escaneado). Solo se aceptan PDF.
2. `triggerValidationAgent(texto)` envía el texto dentro de `query` junto con el
   contexto del formulario (programa, tipo de prueba, registro y fecha).
3. `evaluateAgentResponse()` interpreta la respuesta del agente (JSON estructurado).
   La identidad se contrasta **por dígitos** contra el documento del CRM: el LLM no
   puede afirmar una coincidencia falsa.
4. `validarDatosPrueba()` aplica las reglas deterministas del instructivo ICFES
   sobre el número de registro y la fecha de aplicación (sin LLM).

El agente decide solo identidad, `tipo_documento` y correspondencia programa ↔ prueba.
El número de registro y la fecha los decide el widget con reglas de código.

## Reglas de dominio clave

- El tipo de prueba lo exige el **programa**: pregrado/técnico → Saber 11
  (`AC…`/`VG…`/`CONVENIO`); postgrado → Saber Pro (`EK…`/`gradopostumo`).
- El documento del CRM llega de `Contact_Name.N_mero_de_identificaci_n1`.
- Solo se valida `inputGroupFile1` (saber11) o `inputGroupFile7` (saberpro): el
  primero visible que tenga archivo.
- Conexiones ZRC existentes: `workdrive`, `crm_cun`, `gcp_conn`, `zia_agents`.

## Despliegue

El zip de `dist/` se arma manualmente (entradas `app/global.js`, `app/index.js`,
`app/widget.html`, `app/translations/en.json`). Tras tocar `app/`, reconstruir el
zip y hacer commit + push.

## Licencia

Uso interno.
