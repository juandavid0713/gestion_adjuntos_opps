/* ===========================================================================
   VALIDACIÓN DE ADJUNTOS CON EL AGENTE DE ZIA AGENTS (sección nueva)
   ---------------------------------------------------------------------------
   FLUJO ACTUAL (sin subida a ZFS y SIN "attachments" en el body):
     1. El usuario carga el adjunto de "Pruebas saber11" (#inputGroupFile1) o
        "Pruebas saberpro" (#inputGroupFile7) en el widget.
     2. extraerTextoDocumento(file) extrae el TEXTO del documento:
          - PDF digital        -> pdf-parse v2.4.5 (parser.getText())
          - imagen (jpg/png/..) o PDF escaneado (sin capa de texto)
                               -> OCR con tesseract.js v5.1.1 (spa+eng)
     3. triggerValidationAgent(texto) arma el body
          { "query": "<contexto del formulario + texto extraído>",
            "systemArgs": {}, "reasoning": false }        <- SIN "attachments"
        y lo envía (replica el ejemplo Deluge adjunto y la documentación de la
        "API de agente"). El contexto incluye número de documento, tipo de
        programa, tipo de prueba, número de registro diligenciado y fecha de
        aplicación (construirQuery).
     4. evaluateAgentResponse() interpreta la respuesta del agente ->
        'valid' | 'invalid' | 'unknown' ('unknown' deja el botón bloqueado).
        PRIORIDAD: el JSON estructurado que ahora devuelve el agente
        ({ estado_definitivo, documento_estudiante, tipo_documento,
           coincidencia_identidad, justificacion } -> ver REGLAS DE DECISIÓN
        más abajo). Si ese JSON no viene o está mal formado, se aplica el
        FLUJO DE RESPALDO de siempre (flags estructurados + palabras clave).
     5. Además de la identidad, el widget aplica las reglas DETERMINISTAS del
        instructivo "Validaciones pruebas saber" (PASO 1b de este archivo):
        estructura del código Saber 11 / Saber Pro, coincidencia del número de
        registro del adjunto con el diligenciado y reglas de la fecha de
        aplicación. No dependen del LLM y bloquean el envío si fallan.

   LLAMADA AL AGENTE (replica el ejemplo Deluge adjunto y la documentación de
   la "API de agente"):
      método : POST https://ziaagents.zoho.com/ziaagents/api/v1/agents/
               8500000000798085/trigger   (org 914859810, tomadas del ejemplo)
      headers: X-ZIAAGENTS-ORG: 914859810
               X-ZIAAGENTS-AGENT-SESSION-ID: <ID DE LA OPORTUNIDAD>
               Content-Type: application/json
               Authorization: Zoho-oauthtoken <access-token>  -> lo inyecta ZRC
               desde la conexión ZIAAGENTS_CONNECTION (ámbito ZiaAgents.agents.TRIGGER)
      body   : { "query": "<texto>", "systemArgs": {}, "reasoning": false }

   LIBRERÍAS DE EXTRACCIÓN (cargadas en widget.html ANTES de index.js, con
   versiones fijas en jsDelivr):
      - pdf-parse 2.4.5     -> global "PdfParse"  (UMD + pdf.worker.mjs)
      - tesseract.js 5.1.1  -> global "Tesseract" (UMD)

   SUPUESTOS documentados a pedido del requerimiento:
     1. Conexión ZRC: el valor actual de ZIAAGENTS_CONNECTION es "zia_agents"
        y debe existir en Zoho Connections con permisos para llamar a
        agents.zoho.com / ziaagents.zoho.com (mismo esquema que "workdrive" /
        "crm_cun" que ya se usan en este archivo). Si la conexión tiene otro
        nombre, cambiarla en ZIAAGENTS_CONNECTION.
     2. Respuesta esperada del agente: { "data": { "response": "<texto>" } }.
        El agente responde AHORA con un JSON estructurado que puede llegar como
        objeto, como string JSON puro, envuelto en ```json ... ``` o con texto
        antes/después del objeto: { estado_definitivo, documento_estudiante,
        tipo_documento, coincidencia_identidad, justificacion }.
        evaluateAgentResponse() lo interpreta PRIMERO (ver evaluarRespuestaJson
        y las REGLAS DE DECISIÓN); si ese JSON no viene o está mal formado, se
        aplica el respaldo actual: { response }, { message }, la respuesta
        directa y flags estructurados ({valid:false}, {status:"INVALID"}) con
        PALABRAS_CLAVE_* y PATRON_NEGACION.
     3. El campo "query" del body se arma en construirQuery() (ÚNICO punto de
        ajuste): "Número de documento del estudiante: <doc>" + el texto
        extraído del adjunto. El número de documento se incluye porque el
        agente lo compara contra el contenido del adjunto (requisito previo);
        si se prefiere enviar solo el texto, se cambia en esa función.
     4. ZDK.Client.showLoader reemplaza el mensaje del loader mostrado, por lo
        que los pasos se anuncian en secuencia: "Extrayendo texto del
        documento..." -> "Aplicando OCR..." -> "Validando documento con el
        agente...".
     5. tesseract.js NO recibe "langPath": por defecto descarga los datos de
        idioma desde jsDelivr
        (https://cdn.jsdelivr.net/npm/@tesseract.js-data/<lang>/4.0.0_best_int,
        calculado POR CADA idioma) y un langPath fijo no serviría para la
        combinación "spa+eng".
     6. Si pdf-parse no puede ni leer ni rasterizar el PDF (archivo dañado) o
        si el OCR falla, extraerTextoDocumento() lanza un error; quien llama
        deja la validación en 'unknown' y el botón queda bloqueado.
     7. ZIAAGENTS_AGENT_ID, la URL del trigger, los headers y la conexión NO
        se tocaron: ya estaban correctos.
        https://ziaagents.zoho.com/ziaagents/api/v1/agents/8500000000798085/trigger
     =========================================================================== */

const ZIAAGENTS_ORG_ID = "914859810";
const ZIAAGENTS_AGENT_ID = "8500000000798085";
const ZIAAGENTS_TRIGGER_URL = "https://ziaagents.zoho.com/ziaagents/api/v1/agents/" + ZIAAGENTS_AGENT_ID + "/trigger";
const ZIAAGENTS_CONNECTION = "zia_agents";

/* --- Palabras clave de la respuesta del agente (fáciles de ajustar) --------
   Se comparan en minúsculas y sin acentos (ver normalizarTexto), por lo que se
   pueden escribir con o sin tilde.

   INVÁLIDO = el adjunto NO coincide con el número de documento del estudiante
              O el documento adjunto NO es válido (también aplica a la negación
              "no es válido", "does not match", etc.).
   VÁLIDO   = el agente confirma que el adjunto SÍ corresponde / SÍ es válido.

   IMPORTANTE: se evalúan PRIMERO las de INVÁLIDO, así frases como "no coincide"
   o "no es válido" nunca caen en la lista de válidos por contener "coincide" /
   "válido". */
const PALABRAS_CLAVE_INVALIDO = [
    "no coincide",
    "no correspond",
    "no es válido",
    "no es valido",
    "no válido",
    "no valido",
    "inválido",
    "invalido",
    // Inglés (importante: "invalid" va aquí para que no lo capture "valid")
    "invalid",
    "does not correspond",
    "does not match",
    "document not valid",
    "not valid",
    "no match",
    "mismatch",
    "failed",
    "failure",
    "reject",
    "unmatched",
    "incorrect",
    "rechazad"
];

const PALABRAS_CLAVE_VALIDO = [
    "coincide",
    "corresponde",
    "es válido",
    "es valido",
    "válido",
    "valido",
    "valid",
    "matches",
    "match",
    "aprobado",
    "aprobada",
    "approved",
    "correcto",
    "correcta"
];

/* Negación general: detecta "no" seguido (dentro de una ventana corta) de una
   palabra de la lista VÁLIDO, p. ej. "no es un documento válido" o "el archivo
   no corresponde al estudiante". Se evalúa junto con las palabras clave de
   INVÁLIDO, es decir ANTES que las de VÁLIDO. La ventana es corta a propósito
   para no confundir frases como "no hay observaciones, el documento es válido". */
const PATRON_NEGACION = /\bno\b[^.?!]{0,20}\b(valido|coincide|coinciden|corresponde|corresponden|match|matches|aprobado|aprobada|correcto|correcta)\b/;

/** Minúsculas + sin acentos, para comparar la respuesta con las listas de arriba. */
const normalizarTexto = (texto) => String(texto === null || texto === undefined ? "" : texto)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

let globalState = {
    globalEntity: '',
    globalEntityId: '',
    userId: '',
    periodosVigentes: [],
    contactId: '',
    globalFolderId: '',
    globalTipoPrograma: '',
    globalPrograma: '',
    globalDoc: ''
};

export const setGlobalPrograma = (programa) => {
    globalState.globalPrograma = programa;
};

export const getGlobalPrograma = () => {
    return globalState.globalPrograma;
};

export const setContactInfo = (entity, entityId) => {
    globalState.globalEntity = entity;
    globalState.globalEntityId = entityId;
};

export const getContactInfo = () => {
    return {
        entity: globalState.globalEntity,
        entityId: globalState.globalEntityId,
    };
};

export const setGlobalFolderId = (folderId) => {
    globalState.globalFolderId = folderId;
};

export const getGlobalFolderId = () => {
    return globalState.globalFolderId;
};

export const setGlobalTipoPrograma = (tipoPrograma) => {
    globalState.globalTipoPrograma = tipoPrograma;
};

export const getGlobalTipoPrograma = () => {
    return globalState.globalTipoPrograma;
};

export const setGlobalDoc = (doc) => {
    globalState.globalDoc = doc;
};

export const getGlobalDoc = () => {
    return globalState.globalDoc;
};

/**
 * ZRC puede RESOLVER (sin lanzar) cuando la respuesta trae un error HTTP:
 * { status: 400, data: null, error: { code, message } }. Esta función lanza en
 * ese caso para que los flujos nuevos no continúen con respuestas fallidas.
 */
const verificarRespuestaZrc = (response, contexto) => {
    if (!response || typeof response !== 'object') return response;
    const errorPayload = response.error;
    if (errorPayload && typeof errorPayload === 'object' && (errorPayload.code || errorPayload.message)) {
        throw new Error(contexto + ': ' + (errorPayload.message || errorPayload.code));
    }
    const status = typeof response.status === 'number' ? response.status : null;
    if (status !== null && status >= 400) {
        throw new Error(contexto + ': error HTTP ' + status);
    }
    return response;
};

/**
 * Verificación adicional para CRM: los endpoints de escritura pueden devolver
 * HTTP 200 con el resultado POR REGISTRO dentro de data (patrón habitual:
 * { data: [{ code: "SUCCESS" | "INVALID_DATA" | ..., status: "error", ... }] }).
 * Sin este chequeo, un guardado fallido se vería como exitoso.
 */
const verificarRespuestaCrm = (response, contexto) => {
    verificarRespuestaZrc(response, contexto);
    const cuerpo = response && response.data;
    const registros = (cuerpo && Array.isArray(cuerpo.data)) ? cuerpo.data : [];
    for (const registro of registros) {
        if (!registro || typeof registro !== 'object') continue;
        const estado = (typeof registro.status === 'string') ? registro.status.toLowerCase() : '';
        const codigo = (typeof registro.code === 'string') ? registro.code : '';
        const esError = estado === 'error' || estado === 'failure' ||
            /error|invalid|mandatory|duplicate|not[_ ]?found/i.test(codigo);
        if (esError) {
            throw new Error(contexto + ': ' + (registro.message || codigo || 'Zoho CRM reportó un error al guardar'));
        }
    }
    return response;
};

export const createFolder = async (folderName) => {
     ZDK.Client.showLoader({
                type: 'page',
                template: 'vertical-bar',
                message: 'Creando carpeta...'
        });
    
    const create_folder = await zrc.request({
        method: 'POST',
        path: 'https://www.zohoapis.com/workdrive/api/v1/files',
        connection: 'workdrive',
        body: {
            "data": {
                "attributes": {
                    "name": folderName,
                    "parent_id": "7us0qa3598843e17a4ef1bbd639c34d2c3904"
                },
                "type": "files"
            }
        },
        responseType: 'json'
    });
    ZDK.Client.hideLoader();
    return create_folder;
};

export const getDealsCoql = async (coqlQuery) => {
    ZDK.Client.showLoader({
                type: 'page',
                template: 'vertical-bar',
                message: 'Recuperando información...'
        });
    const response = await zrc.post("/crm/v8/coql", coqlQuery);
    ZDK.Client.hideLoader();
    return response;
};

/* Nombres API de los campos nuevos de la oportunidad, indicados tal cual en el
   requerimiento: Fecha_aplicaci_n_prueba y N_mero_de_registro_prueba. */
const API_NAME_FECHA_APLICACION = "Fecha_aplicaci_n_prueba";
const API_NAME_NUMERO_REGISTRO = "N_mero_de_registro_prueba";

/**
 * Actualiza la oportunidad.
 *
 * Backward-compatible: se conserva la firma original updateDeal(dealId, folderId)
 * y se acepta también updateDeal(dealId, { folderId, fechaAplicacionPrueba,
 * numeroRegistro }). Los campos nuevos SOLO se envían si tienen valor, de modo
 * que la llamada de PageLoad (que únicamente guarda la carpeta recién creada)
 * no se rompe.
 *
 * @param {string} dealId  id de la oportunidad
 * @param {string|object} options  folderId (string) u objeto { folderId, fechaAplicacionPrueba, numeroRegistro }
 */
export const updateDeal = async (dealId, options) => {
    let folderId = '';
    let fechaAplicacionPrueba = '';
    let numeroRegistro = '';

    if (options !== null && typeof options === 'object') {
        folderId = options.folderId || '';
        // Se recortan los espacios: un valor en blanco no debe enviarse
        fechaAplicacionPrueba = String(options.fechaAplicacionPrueba || '').trim();
        numeroRegistro = String(options.numeroRegistro || '').trim();
    } else {
        folderId = options || '';
    }

    const payload = {};
    if (folderId !== '' && folderId !== null && folderId !== undefined) {
        payload.Workdrive_Folder_ID = folderId;
    }
    // Campo tipo Date de Zoho CRM: formato "YYYY-MM-DD" (value del input type="date")
    if (fechaAplicacionPrueba) {
        payload[API_NAME_FECHA_APLICACION] = fechaAplicacionPrueba;
    }
    // Campo tipo Text: string tal como lo escribió el usuario
    if (numeroRegistro) {
        payload[API_NAME_NUMERO_REGISTRO] = numeroRegistro;
    }

    const enviar = (data) => zrc.put(`/crm/v8/Deals/${dealId}`, { data: [data] });

    ZDK.Client.showLoader({
                type: 'page',
                template: 'vertical-bar',
                message: 'Actualizando oportunidad...'
        });

    let response;
    try {
        response = await enviar(payload);
        verificarRespuestaCrm(response, 'updateDeal');
    } finally {
        ZDK.Client.hideLoader();
    }
    return response;
};


export const uploadFile = async (file, parentId,fileType) => {
     ZDK.Client.showLoader({
                type: 'page',
                template: 'vertical-bar',
                message: 'Subiendo archivos...'
    });
    
	const folderId = parentId;
	const path = "https://zohoapis.com/workdrive/api/v1/upload";
	const formData = new FormData();
	formData.append("filename", file.name);
	formData.append("override-name-exist", "true");
	formData.append("parent_id", folderId);
	formData.append("content", file);
	const uploadRes = await zrc.post(path, formData, {
		connection: "workdrive"
	});
    ZDK.Client.hideLoader();
    return uploadRes;
};

export const linkFile = async (dealId, permalink, title) => {
     ZDK.Client.showLoader({
                type: 'page',
                template: 'vertical-bar',
                message: 'Linkeando archivos...'
    });
    let perma = encodeURIComponent(permalink);
    let tit = encodeURIComponent(title);
    const linkRes2 = await zrc.request({
        method: "post",
        path: `https://www.zohoapis.com/crm/v8/Deals/${dealId}/Attachments/attachmentUrl=${permalink}&title=${title}`,
        headers: {
                "content-type": "boundary=----WebKitFormBoundarYWxkTrZu0gW"
        },
        connection: "crm_cun",
        
    }); 
    ZDK.Client.hideLoader();
    return linkRes2;
};

export const fileToGCP = async (file,fileName,doc) => {
    ZDK.Client.showLoader({
        type: 'page',
        template: 'vertical-bar',
        message: 'Subiendo archivo a GCP...'
    });
    const contentType = file.type || 'application/octet-stream';
    //console.log('tipo de archivo:', contentType);
    const rawPath = `zoho/oportunidades/${doc}/${fileName}`;
    const encodedPath = encodeURIComponent(rawPath);
    const formData = new FormData();
    formData.append("file", file);

    const response = await zrc.request({
        method: "post",
        headers : {
            "Content-Type": contentType,
        },
        path: `https://www.googleapis.com/upload/storage/v1/b/it-docs-fuv2-std-useast4/o?uploadType=media&name=${encodedPath}`,
        body: formData,
        connection: "gcp_conn"
    });

    ZDK.Client.hideLoader();
    return response;
};

export const fileToAWS = async (file, fileName, doc, program) => {
    ZDK.Client.showLoader({
        type: 'page',
        template: 'vertical-bar',
        message: 'Subiendo archivo a AWS...'
    });

    const getToken = await zrc.request({
        method: "post",
        headers: {
            "x-internal-key": "a7b3c9f2e1d4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"
        },
        path: `https://appdocat.cunapp.pro/internal/generate-token`,
    });
    const token = getToken.data.token;
    //console.log("getToken:", getToken);
    //console.log('Token obtenido para AWS S3:', token);
    let bodyParams = new FormData();
    bodyParams.append("cedula", doc);
    bodyParams.append("programa", program);
    bodyParams.append("file", file);
    bodyParams.append("source", "zoho");
    bodyParams.append("tipoDocumento", fileName);
    const uploadResponseAWS = await zrc.request({
        method: "post",
        headers: {
            "Authorization": `Bearer ${token}`
        },
        path: `https://appdocat.cunapp.pro/storage/upload/v2`,
        body: bodyParams
    });
    //console.log('respuesta upload AWS S3:', uploadResponseAWS.data);
    

    ZDK.Client.hideLoader();
    return uploadResponseAWS;
};

/* ===========================================================================
   EXTRACCIÓN DE TEXTO DEL ADJUNTO (nuevo flujo: SIN subida a ZFS)
   ---------------------------------------------------------------------------
   El texto del documento viaja al agente dentro de "query", por lo que ya NO
   se sube el archivo a ZFS y el body NO lleva la llave "attachments".

   Librerías cargadas en widget.html con versiones fijas:
     - pdf-parse 2.4.5   global "PdfParse"  -> PDF digital (getText) y
                           rasterizado de páginas (getScreenshot) para el OCR.
     - tesseract.js 5.1.1 global "Tesseract" -> OCR de imágenes y de PDFs
                           escaneados, idiomas "spa+eng".
   =========================================================================== */

// Constantes ajustables (exportadas para poder probarlas):

// PDF con al menos esta cantidad de caracteres alfanuméricos -> PDF digital
export const MIN_CARACTERES_PDF_DIGITAL = 30;
// OCR (imágenes y PDF escaneado): por debajo de esta cantidad de caracteres
// alfanuméricos se considera que el OCR no leyó el documento (texto basura).
// En ese caso se lanza error -> la validación queda en 'unknown' (con opción de
// reintentar) en vez de mandar texto ilegible al agente.
export const MIN_CARACTERES_OCR = 20;
// Máximo de páginas del PDF que se rasterizan para aplicar OCR (velocidad)
export const MAX_PAGINAS_OCR = 3;
// Ancho (px) al rasterizar cada página: ~300 DPI para una hoja carta
const ANCHO_PAGINA_OCR = 2200;
/* --- CALIDAD DEL OCR (prevención de dígitos perdidos) ----------------------
   En pruebas con imágenes pequeñas (p. ej. 794x678) el OCR perdía dígitos del
   número de documento (leía 104751026 en vez de 1047510261). Para evitarlo:
     1) se REESCALA la imagen (ancho mínimo OCR_ANCHO_MINIMO px, hasta
        OCR_ANCHO_MAXIMO) con interpolación de alta calidad,
     2) se pasa a escala de grises con realce de contraste,
     3) se le indica a Tesseract un DPI fijo (OCR_DPI) para que no tenga que
        estimarlo (con imágenes pequeñas estima mal y pierde precisión),
     4) si el resultado trae pocos dígitos (OCR_DIGITOS_MINIMOS) se repite el
        OCR sobre la versión BINARIZADA (umbral de Otsu) y se queda con el
        mejor de los dos resultados. */
export const OCR_ANCHO_MINIMO = 2200;
export const OCR_ANCHO_MAXIMO = 4400;
export const OCR_DPI = '300';
export const OCR_DIGITOS_MINIMOS = 8;
export const OCR_PRESERVAR_ESPACIOS = '1';
// Factor de realce de contraste aplicado en escala de grises (1 = sin cambio)
export const OCR_CONTRASTE = 1.35;
// Factor de realce de NITIDEZ (unsharp 3x3: centro 1+4*k, vecinos -k).
// Validado con una imagen real (794x678): sin nitidez el OCR leía
// "104751026" (perdía el último dígito del documento); con nitidez leyó
// "1047510261" completo. k=1 => kernel [0 -1 0 / -1 5 -1 / 0 -1 0].
export const OCR_NITIDEZ = 1;
// Tope de caracteres del texto que viaja en "query". El número de documento
// SIEMPRE queda al inicio, aunque se recorte el final del texto.
export const MAX_CARACTERES_QUERY = 20000;
// Idiomas del OCR: español + inglés
const TESSERACT_IDIOMAS = 'spa+eng';
// OEM.LSTM_ONLY (=1), el mismo modo que usa Tesseract.recognize por defecto
const TESSERACT_OEM_LSTM_ONLY = 1;
// Rutas explícitas de tesseract.js (versiones fijas en jsDelivr). "langPath"
// NO se pasa a propósito: ver SUPUESTO 5 de la cabecera del archivo.
const TESSERACT_WORKER_PATH = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js';
const TESSERACT_CORE_PATH = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1';
// Worker de pdf.js que utiliza pdf-parse dentro del navegador
const PDF_PARSE_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdf-parse@2.4.5/dist/pdf-parse/web/pdf.worker.mjs';

/**
 * Accede a una global cargada por <script> en widget.html ("PdfParse",
 * "Tesseract"). globalThis cubre el navegador (window) y también los mocks
 * que se inyectan en las pruebas de Node.
 */
const obtenerGlobal = (nombre) => {
    if (typeof globalThis !== 'undefined' && globalThis[nombre]) return globalThis[nombre];
    if (typeof window !== 'undefined' && window[nombre]) return window[nombre];
    return null;
};

/**
 * Muestra/actualiza el loader del paso actual (ZDK reemplaza el mensaje).
 * Se oculta antes de mostrar para no apilar overlays si ZDK creara varios.
 */
const mostrarLoader = (mensaje) => {
    ZDK.Client.hideLoader();
    ZDK.Client.showLoader({
        type: 'page',
        template: 'vertical-bar',
        message: mensaje
    });
};

/** ¿El archivo seleccionado es un PDF? (por MIME o por extensión) */
const esArchivoPdf = (file) => {
    const nombre = String((file && file.name) || '').toLowerCase();
    const tipo = String((file && file.type) || '').toLowerCase();
    return tipo === 'application/pdf' || /\.pdf$/.test(nombre);
};

/** Cuenta caracteres alfanuméricos (incluye tildes/ñ), sin espacios ni signos. */
const contarCaracteresAlfanumericos = (texto) => {
    const fuente = String(texto === null || texto === undefined ? '' : texto);
    const coincidencias = fuente.match(/[0-9a-zA-ZáéíóúñüÁÉÍÓÚÑÜ]/g);
    return coincidencias ? coincidencias.length : 0;
};

/** Texto con espacios/saltos de línea colapsados (para decidir si hay contenido). */
const colapsarEspacios = (texto) => String(texto === null || texto === undefined ? '' : texto)
    .replace(/\s+/g, ' ')
    .trim();

// pdf-parse necesita apuntar al worker de pdf.js; se hace una sola vez.
let workerPdfParseConfigurado = false;
const asegurarWorkerPdfParse = () => {
    if (workerPdfParseConfigurado) return;
    const lib = obtenerGlobal('PdfParse');
    if (lib && lib.PDFParse && typeof lib.PDFParse.setWorker === 'function') {
        lib.PDFParse.setWorker(PDF_PARSE_WORKER_URL);
        workerPdfParseConfigurado = true;
        console.log('[ZET][PDF] Worker de pdf.js apuntado a:', PDF_PARSE_WORKER_URL);
    }
};

/** Crea un parser de pdf-parse a partir del archivo seleccionado. */
const crearParserPdf = async (file) => {
    const lib = obtenerGlobal('PdfParse');
    if (!lib || typeof lib.PDFParse !== 'function') {
        throw new Error('pdf-parse no está disponible (no se cargó el script del CDN en widget.html).');
    }
    asegurarWorkerPdfParse();
    const buffer = await file.arrayBuffer();
    // LoadParameters acepta { data: Uint8Array }; cada parser recibe su propio
    // buffer porque pdf.js puede transferir la propiedad del arreglo.
    return new lib.PDFParse({ data: new Uint8Array(buffer) });
};

/**
 * PASO 2a) Texto de un PDF digital con pdf-parse.
 * pageJoiner:'' para que NO inyecte los marcadores "-- page 1 of 3 --".
 */
const extraerTextoPdf = async (file) => {
    const parser = await crearParserPdf(file);
    try {
        const resultado = await parser.getText({ pageJoiner: '' });
        return resultado && typeof resultado.text === 'string' ? resultado.text : '';
    } finally {
        try {
            await parser.destroy();
        } catch (err) {
            console.warn('[ZET][PDF] No se pudo liberar el parser:', err);
        }
    }
};

/**
 * PASO 2b) Rasteriza las primeras MAX_PAGINAS_OCR páginas del PDF a dataURL
 * (pdf-parse.getScreenshot) para pasarlas al OCR.
 */
const rasterizarPaginasPdf = async (file) => {
    const parser = await crearParserPdf(file);
    try {
        const resultado = await parser.getScreenshot({
            first: MAX_PAGINAS_OCR,
            desiredWidth: ANCHO_PAGINA_OCR,
            imageDataUrl: true,
            imageBuffer: false
        });
        const paginas = (resultado && Array.isArray(resultado.pages)) ? resultado.pages : [];
        return paginas
            .map(p => (p && typeof p.dataUrl === 'string') ? p.dataUrl : '')
            .filter(d => d !== '');
    } finally {
        try {
            await parser.destroy();
        } catch (err) {
            console.warn('[ZET][PDF] No se pudo liberar el parser de imágenes:', err);
        }
    }
};

/**
 * OCR con tesseract.js sobre UNA o varias imágenes (File o dataURL).
 * Se crea UN solo worker para todas las imágenes y se termina al finalizar.
 */
/** Cuenta dígitos en un texto (métrica para comparar resultados de OCR). */
const contarDigitos = (texto) => {
    const m = String(texto === null || texto === undefined ? '' : texto).match(/[0-9]/g);
    return m ? m.length : 0;
};

/* --- Identificación leída por OCR: candidato y calidad ---------------------
   Contar dígitos NO alcanza para imágenes: un reporte trae DANE (12), número
   de registro (AC/EK…), puntajes, percentiles y fechas, así que el pass 1 puede
   sumar 8+ dígitos aunque el número de IDENTIFICACIÓN esté mal leído. Por eso
   se localiza el candidato anclado a su etiqueta y se compara con el documento
   del CRM: si no coincide exactamente, se ejecuta el pass 2 (binarizado). */

const RE_ETIQUETA_IDENTIDAD = /identificaci[oó06a-z]{0,2}[oó06]n\s*[:.]?\s*/i;
const RE_PREFIJO_DOC = /^(?:C\.?\s?C\.?|T\.?\s?I\.?|C\.?\s?E\.?|R\.?\s?C\.?|P\.?\s?A\.?|PASAPORTE|CEDULA DE CIUDADANIA|CÉDULA DE CIUDADANÍA|TARJETA DE IDENTIDAD|DOCUMENTO)\s*[:.]?\s*/i;
// Secuencia candidata: dígitos + letras que Tesseract confunde con dígitos
const RE_SECUENCIA_DOC = /[0-9OoQIlSBZG][0-9OoQIlSBZG.,\s-]{4,}/;
// Líneas de otros números que NUNCA son la identificación
const RE_LINEA_DISTRACTOR = /registro|DANE|SNIES|puntaje|percentil|fecha/i;

/** Corrige confusiones OCR letra->dígito y deja solo dígitos. */
const normalizarCandidatoIdentidad = (valor) => String(valor === null || valor === undefined ? '' : valor)
    .replace(/[OoQ]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/S/g, '5')
    .replace(/B/g, '8')
    .replace(/Z/g, '2')
    .replace(/G/g, '6')
    .replace(/\D/g, '');

/** Devuelve los dígitos del candidato si tiene longitud de documento (6-11). */
const validarCandidatoIdentidad = (valor) => {
    const digitos = normalizarCandidatoIdentidad(valor);
    return (digitos.length >= 6 && digitos.length <= 11) ? digitos : '';
};

/** Primer documento válido dentro de un fragmento de texto. */
const buscarCandidatoEnFragmento = (fragmento) => {
    const resto = String(fragmento || '').replace(RE_PREFIJO_DOC, '').trim();
    const m = resto.match(RE_SECUENCIA_DOC);
    return m ? validarCandidatoIdentidad(m[0]) : '';
};

/**
 * Extrae el número de identificación ANCLADO a su etiqueta. Reconoce los
 * formatos de los adjuntos reales:
 *   1) «Identificación: CC 1047510261»          (valor en la misma línea)
 *   2) «Identificación:» + «T.I. 1011102846»    (valor en la línea siguiente)
 *   3) «NOMBRE DOCUMENTO DE IDENTIDAD» + «APELLIDOS NOMBRES 79970859»
 *   4) «CEDULA DE CIUDADANIA 53075949»          (certificado de asistencia)
 * Devuelve SOLO dígitos o '' si no encuentra un candidato fiable.
 */
export const extraerCandidatoIdentidad = (texto) => {
    const lineas = String(texto === null || texto === undefined ? '' : texto)
        .split(/\r?\n/).map(l => l.trim());

    // 1) Identificación con el valor en la misma línea
    for (const linea of lineas) {
        const m = linea.match(RE_ETIQUETA_IDENTIDAD);
        if (!m) continue;
        const candidato = buscarCandidatoEnFragmento(linea.slice(m.index + m[0].length));
        if (candidato) return candidato;
    }

    // 2) Etiqueta sola: el valor está en las 2 líneas siguientes
    for (let i = 0; i < lineas.length; i++) {
        if (!/^identificaci[oó06a-z]{0,2}[oó06]n\s*[:.]?$/i.test(lineas[i])) continue;
        for (let j = i + 1; j <= i + 2 && j < lineas.length; j++) {
            if (RE_LINEA_DISTRACTOR.test(lineas[j])) continue;
            const candidato = buscarCandidatoEnFragmento(lineas[j]);
            if (candidato) return candidato;
        }
    }

    // 3) Certificado de asistencia: «CEDULA DE CIUDADANIA 53075949»
    for (const linea of lineas) {
        const m = linea.match(/(?:CEDULA DE CIUDADANIA|CÉDULA DE CIUDADANÍA|TARJETA DE IDENTIDAD)\s+(.+)$/i);
        if (!m) continue;
        const candidato = buscarCandidatoEnFragmento(m[1]);
        if (candidato) return candidato;
    }

    // 4) Informe antiguo: encabezado «DOCUMENTO DE IDENTIDAD»; el número va al
    //    final de la línea del nombre.
    for (let i = 0; i < lineas.length; i++) {
        if (!/documento de identidad/i.test(lineas[i])) continue;
        for (let j = i + 1; j <= i + 3 && j < lineas.length; j++) {
            if (RE_LINEA_DISTRACTOR.test(lineas[j])) continue;
            const m = lineas[j].match(/([0-9][0-9.,\s-]{4,})\s*$/);
            if (!m) continue;
            const candidato = validarCandidatoIdentidad(m[1]);
            if (candidato) return candidato;
        }
    }

    return '';
};

/**
 * Calidad de un texto de OCR respecto al documento del CRM.
 *   nivel 3 -> el candidato de identificación coincide EXACTO con el CRM
 *   nivel 2 -> hay candidato y la longitud coincide (posible error de 1 dígito)
 *   nivel 1 -> hay candidato pero con otra longitud
 *   nivel 0 -> no se localizó la identificación
 * Sirve solo para ELEGIR entre variantes de OCR; la validez la decide el agente.
 */
const evaluarCalidadOcr = (texto, documentoCrm) => {
    const candidato = extraerCandidatoIdentidad(texto);
    let nivel = 0;
    if (candidato) {
        if (documentoCrm && candidato === documentoCrm) nivel = 3;
        else if (documentoCrm && candidato.length === documentoCrm.length) nivel = 2;
        else nivel = 1;
    }
    return {
        candidato,
        nivel,
        digitos: contarDigitos(texto),
        alfa: contarCaracteresAlfanumericos(texto)
    };
};

/** true si `a` es mejor que `b` (calidad de identificación y luego texto). */
const esMejorOcr = (a, b) => {
    if (a.nivel !== b.nivel) return a.nivel > b.nivel;
    if (a.digitos !== b.digitos) return a.digitos > b.digitos;
    return a.alfa > b.alfa;
};

/** Umbral de Otsu a partir de un histograma de 256 bins. */
const umbralOtsu = (histograma) => {
    const total = histograma.reduce((a, b) => a + b, 0);
    if (total === 0) return 128;
    let sumaTotal = 0;
    for (let i = 0; i < 256; i++) sumaTotal += i * histograma[i];
    let sumaFondo = 0, pesoFondo = 0, mejorVarianza = 0, umbral = 127;
    for (let i = 0; i < 256; i++) {
        pesoFondo += histograma[i];
        if (pesoFondo === 0) continue;
        const pesoFrente = total - pesoFondo;
        if (pesoFrente === 0) break;
        sumaFondo += i * histograma[i];
        const mediaFondo = sumaFondo / pesoFondo;
        const mediaFrente = (sumaTotal - sumaFondo) / pesoFrente;
        const varianza = pesoFondo * pesoFrente * (mediaFondo - mediaFrente) * (mediaFondo - mediaFrente);
        if (varianza > mejorVarianza) { mejorVarianza = varianza; umbral = i; }
    }
    return umbral;
};

/**
 * Prepara una imagen para OCR (mejora la precisión en dígitos):
 *   1) reescalado con interpolación de alta calidad (ancho mínimo
 *      OCR_ANCHO_MINIMO px, tope OCR_ANCHO_MAXIMO),
 *   2) escala de grises con realce de contraste.
 * Devuelve el <canvas> procesado o la FUENTE ORIGINAL si algo falla (así el
 * OCR sigue funcionando aunque falle el preprocesado o no haya DOM, p. ej.
 * las pruebas en Node).
 */
const preprocesarImagenParaOCR = async (fuente) => {
    if (typeof document === 'undefined' || !document.createElement) return fuente;
    let urlObjeto = null;
    try {
        const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('No se pudo cargar la imagen para el OCR.'));
            if (typeof Blob !== 'undefined' && fuente instanceof Blob) {
                urlObjeto = URL.createObjectURL(fuente);
                el.src = urlObjeto;
            } else {
                el.src = fuente; // dataURL (p. ej. página rasterizada de un PDF)
            }
        });
        if (!img || !img.width || !img.height) return fuente;

        const anchoObjetivo = Math.min(Math.max(img.width * 2, OCR_ANCHO_MINIMO), OCR_ANCHO_MAXIMO);
        const factor = anchoObjetivo / img.width;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * factor);
        canvas.height = Math.round(img.height * factor);
        const ctx = canvas.getContext('2d');
        if (!ctx) return fuente;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        // Escala de grises + realce de contraste lineal alrededor del 128
        const datos = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = datos.data;
        for (let i = 0; i < d.length; i += 4) {
            const gris = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            const valor = (gris - 128) * OCR_CONTRASTE + 128;
            const v = valor < 0 ? 0 : (valor > 255 ? 255 : valor);
            d[i] = d[i + 1] = d[i + 2] = v;
        }
        ctx.putImageData(datos, 0, 0);

        // Realce de nitidez: paso CLAVE para no perder dígitos en documentos
        // pequeños o con tipografía fina (validado con una imagen real donde
        // el OCR leía "104751026" en vez de "1047510261").
        realzarNitidezCanvas(canvas);

        console.log('[ZET][OCR] Imagen preprocesada:', img.width + 'x' + img.height,
            '->', canvas.width + 'x' + canvas.height);
        return canvas;
    } catch (err) {
        console.warn('[ZET][OCR] No se pudo preprocesar la imagen; se usa el original:', err);
        return fuente;
    } finally {
        if (urlObjeto) {
            try { URL.revokeObjectURL(urlObjeto); } catch (e) { /* noop */ }
        }
    }
};

/**
 * Realza la NITIDEZ del <canvas> con un kernel "unsharp" 3x3
 * [0 -1 0 / -1 (1+4k) -1 / 0 -1 0] con k = OCR_NITIDEZ (=1 -> centro 5).
 * Opera sobre escala de grises (los 3 canales son iguales tras la conversión
 * anterior). Validado contra una imagen real: es el paso que recupera el
 * último dígito del número de documento que el OCR perdía.
 * Devuelve el mismo <canvas>.
 */
const realzarNitidezCanvas = (canvas) => {
    if (!canvas || typeof canvas.getContext !== 'function') return canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    const { width: w, height: h } = canvas;
    if (w < 3 || h < 3) return canvas;
    const datos = ctx.getImageData(0, 0, w, h);
    const d = datos.data;
    const centro = 1 + 4 * OCR_NITIDEZ;
    const copia = new Uint8ClampedArray(d); // leer píxeles vecinos sin pisarlos
    const idx = (x, y) => (y * w + x) * 4;
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = idx(x, y);
            const c = copia[i];
            const v = centro * c
                - OCR_NITIDEZ * copia[idx(x - 1, y)]
                - OCR_NITIDEZ * copia[idx(x + 1, y)]
                - OCR_NITIDEZ * copia[idx(x, y - 1)]
                - OCR_NITIDEZ * copia[idx(x, y + 1)];
            const s = v < 0 ? 0 : (v > 255 ? 255 : v);
            d[i] = d[i + 1] = d[i + 2] = s; // bordes intactos (no se tocan)
        }
    }
    ctx.putImageData(datos, 0, 0);
    return canvas;
};

/** Binariza un <canvas> con el umbral de Otsu (devuelve el mismo canvas). */
const binarizarCanvas = (canvas) => {
    if (!canvas || typeof canvas.getContext !== 'function') return canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    const datos = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = datos.data;
    const histograma = new Array(256).fill(0);
    for (let i = 0; i < d.length; i += 4) {
        histograma[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
    }
    const umbral = umbralOtsu(histograma);
    for (let i = 0; i < d.length; i += 4) {
        const gris = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const v = gris > umbral ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(datos, 0, 0);
    return canvas;
};

/**
 * Crea y configura el worker de tesseract.js (operación COSTOSA: descarga el
 * core wasm y los datos de idioma). Por eso ocrConCalidad lo crea UNA sola vez
 * y lo comparte entre el pass 1 y el pass 2.
 * Parámetros de calidad: DPI fijo (evita que Tesseract lo estime mal en
 * imágenes pequeñas, causa típica de dígitos perdidos) y espacios preservados.
 */
const crearWorkerTesseract = async () => {
    const Tesseract = obtenerGlobal('Tesseract');
    if (!Tesseract || typeof Tesseract.createWorker !== 'function') {
        throw new Error('tesseract.js no está disponible (no se cargó el script del CDN en widget.html).');
    }
    const worker = await Tesseract.createWorker(TESSERACT_IDIOMAS, TESSERACT_OEM_LSTM_ONLY, {
        workerPath: TESSERACT_WORKER_PATH,
        corePath: TESSERACT_CORE_PATH,
        logger: (m) => {
            if (!m) return;
            const pct = typeof m.progress === 'number' ? Math.round(m.progress * 100) : 0;
            console.log('[ZET][OCR]', m.status, pct + '%');
        }
    });
    // Parámetros de calidad del OCR
    if (typeof worker.setParameters === 'function') {
        try {
            await worker.setParameters({
                user_defined_dpi: OCR_DPI,
                preserve_interword_spaces: OCR_PRESERVAR_ESPACIOS
            });
        } catch (err) {
            console.warn('[ZET][OCR] No se pudieron aplicar los parámetros (se usa la configuración por defecto):', err);
        }
    }
    return worker;
};

/** Termina el worker de OCR sin propagar errores (limpieza). */
const terminarWorkerTesseract = async (worker) => {
    if (worker && typeof worker.terminate === 'function') {
        try {
            await worker.terminate();
        } catch (err) {
            console.warn('[ZET][OCR] No se pudo terminar el worker:', err);
        }
    }
};

/**
 * OCR con tesseract.js sobre UNA o varias imágenes (File, dataURL o canvas).
 *
 * @param {Array<File|string|HTMLCanvasElement>} imagenes
 * @param {object|null} workerExistente  worker YA creado (se reutiliza y NO se
 *        termina aquí; lo termina quien lo creó). Si es null se crea uno y se
 *        termina al finalizar.
 */
const reconocerConTesseract = async (imagenes, workerExistente = null) => {
    const worker = workerExistente || await crearWorkerTesseract();
    try {
        const textos = [];
        for (const imagen of imagenes) {
            const res = await worker.recognize(imagen);
            const texto = (res && res.data && typeof res.data.text === 'string') ? res.data.text.trim() : '';
            if (texto !== '') textos.push(texto);
        }
        return textos.join('\n\n').trim();
    } finally {
        if (!workerExistente) await terminarWorkerTesseract(worker);
    }
};

/**
 * OCR "de calidad" contra la pérdida de dígitos:
 *   Pass 1 -> preprocesa cada imagen (reescalado + grises + contraste + nitidez)
 *             y OCR.
 *   Pass 2 -> se repite sobre la versión BINARIZADA (umbral de Otsu) cuando:
 *             a) NO se localizó el número de identificación (o no coincide con
 *                el documento del CRM), o
 *             b) no hay documento del CRM y el pass 1 trae pocos dígitos
 *                (menos de OCR_DIGITOS_MINIMOS).
 *             Se queda con el MEJOR texto: primero por calidad de la
 *             identificación (nivel 3 = coincide exacto con el CRM), luego por
 *             cantidad de dígitos y de caracteres alfanuméricos.
 *
 * IMPORTANTE: ambos passes comparten el MISMO worker (crear uno nuevo cuesta
 * varios segundos porque descarga el core wasm y los datos de idioma).
 *
 * @param {Array<File|string|HTMLCanvasElement>} fuentes imágenes a reconocer
 * @returns {Promise<string>} texto consolidado
 */
const ocrConCalidad = async (fuentes) => {
    const lista = Array.isArray(fuentes) ? fuentes : [fuentes];
    const preprocesadas = [];
    for (const fuente of lista) {
        preprocesadas.push(await preprocesarImagenParaOCR(fuente));
    }

    // Documento del CRM: se usa SOLO para elegir la mejor variante de OCR.
    // Se ignora si no tiene una longitud plausible (6-11 dígitos).
    const documentoCrmCrudo = normalizarCandidatoIdentidad(getGlobalDoc());
    const documentoCrm = (documentoCrmCrudo.length >= 6 && documentoCrmCrudo.length <= 11)
        ? documentoCrmCrudo : '';

    const worker = await crearWorkerTesseract();
    try {
        const primero = await reconocerConTesseract(preprocesadas, worker);
        const calidadPrimero = evaluarCalidadOcr(primero, documentoCrm);
        console.log('[ZET][OCR] Pass 1 (reescalado+contraste+nitidez) | caracteres:', primero.length,
            '| dígitos:', calidadPrimero.digitos,
            '| candidato:', calidadPrimero.candidato || '(no localizado)',
            '| nivel:', calidadPrimero.nivel);

        // Coincidencia exacta con el CRM: no hace falta reintentar
        if (calidadPrimero.nivel === 3) return primero;

        // Sin documento del CRM: se mantiene la heurística anterior
        if (!documentoCrm && calidadPrimero.digitos >= OCR_DIGITOS_MINIMOS) return primero;

        if (documentoCrm) {
            console.warn('[ZET][OCR] La identificación del pass 1 no coincide con el CRM; se reintenta sobre la versión BINARIZADA.');
        } else {
            console.warn('[ZET][OCR] Pocos dígitos en el pass 1; se reintenta sobre la versión BINARIZADA.');
        }
        const binarizadas = preprocesadas.map(p => binarizarCanvas(p));
        const segundo = await reconocerConTesseract(binarizadas, worker);
        const calidadSegundo = evaluarCalidadOcr(segundo, documentoCrm);
        console.log('[ZET][OCR] Pass 2 (binarizado) | caracteres:', segundo.length,
            '| dígitos:', calidadSegundo.digitos,
            '| candidato:', calidadSegundo.candidato || '(no localizado)',
            '| nivel:', calidadSegundo.nivel);

        if (esMejorOcr(calidadSegundo, calidadPrimero)) {
            console.log('[ZET][OCR] Se conserva el resultado del pass 2 (binarizado).');
            return segundo;
        }
        console.log('[ZET][OCR] Se conserva el resultado del pass 1 (realce).');
        return primero;
    } finally {
        await terminarWorkerTesseract(worker);
    }
};

/**
 * PASO 1) Extrae el TEXTO del adjunto cargado.
 *
 *   - No es PDF (imagen) -> OCR con preprocesado (ocrConCalidad: reescalado
 *     + escala de grises + contraste, y reintento binarizado si faltan
 *     dígitos).
 *   - Es PDF -> intento con pdf-parse; si el texto tiene al menos
 *     MIN_CARACTERES_PDF_DIGITAL caracteres alfanuméricos es PDF digital;
 *     si no (PDF escaneado), se rasterizan MAX_PAGINAS_OCR páginas y cada
 *     imagen pasa por OCR.
 *   - Si pdf-parse falla se intenta OCR como respaldo; si todo falla se
 *     lanza un error con mensaje claro (quien llama deja la validación en
 *     'unknown' y el botón queda bloqueado).
 *
 * Mensajes del loader por paso: "Extrayendo texto del documento..." y
 * "Aplicando OCR..." (el paso siguiente, "Validando documento con el
 * agente...", lo muestra triggerValidationAgent).
 *
 * @param {File} file archivo seleccionado en inputGroupFile1 o inputGroupFile7
 * @returns {Promise<{texto: string, metodo: 'pdf-digital'|'ocr'}>}
 */
export const extraerTextoDocumento = async (file) => {
    if (!file) {
        throw new Error('No se recibió el archivo para extraer el texto.');
    }
    console.log('[ZET][Extracción] Archivo:', file.name, '| tipo:', file.type);

    try {
        // --- Imagen (jpg/png/...): OCR con preprocesado ---------------------
        if (!esArchivoPdf(file)) {
            mostrarLoader('Aplicando OCR...');
            const texto = await ocrConCalidad([file]);
            const alfa = contarCaracteresAlfanumericos(texto);
            if (alfa < MIN_CARACTERES_OCR) {
                throw new Error('El OCR no detectó texto suficiente en la imagen (' + alfa +
                    ' caracteres). Cargue una imagen más nítida o el PDF original.');
            }
            console.log('[ZET][Extracción] OCR de imagen OK. caracteres:', texto.length);
            return { texto: texto, metodo: 'ocr' };
        }

        // --- PDF: primero se intenta la capa de texto con pdf-parse --------
        mostrarLoader('Extrayendo texto del documento...');
        let textoDigital = '';
        try {
            textoDigital = await extraerTextoPdf(file);
        } catch (err) {
            console.warn('[ZET][Extracción] pdf-parse falló, se intentará OCR:', err);
        }

        if (contarCaracteresAlfanumericos(colapsarEspacios(textoDigital)) >= MIN_CARACTERES_PDF_DIGITAL) {
            console.log('[ZET][Extracción] PDF digital. caracteres alfanuméricos:', contarCaracteresAlfanumericos(textoDigital));
            return { texto: textoDigital, metodo: 'pdf-digital' };
        }

        // --- PDF escaneado (o sin capa de texto): rasterizar + OCR ---------
        console.log('[ZET][Extracción] PDF sin capa de texto útil; OCR sobre las primeras', MAX_PAGINAS_OCR, 'página(s).');
        mostrarLoader('Aplicando OCR...');
        let textoOcr = '';
        let errorOcr = null;
        try {
            const paginas = await rasterizarPaginasPdf(file);
            console.log('[ZET][Extracción] Páginas rasterizadas para OCR:', paginas.length);
            if (paginas.length > 0) {
                textoOcr = await ocrConCalidad(paginas);
            }
        } catch (err) {
            errorOcr = err;
            console.warn('[ZET][Extracción] OCR del PDF falló:', err);
        }

        if (textoOcr !== '' && contarCaracteresAlfanumericos(textoOcr) >= MIN_CARACTERES_OCR) {
            console.log('[ZET][Extracción] OCR del PDF OK. caracteres:', textoOcr.length);
            return { texto: textoOcr, metodo: 'ocr' };
        }
        if (textoOcr !== '') {
            console.warn('[ZET][Extracción] El OCR del PDF devolvió muy poco texto (' +
                contarCaracteresAlfanumericos(textoOcr) + ' caracteres alfanuméricos); no se usa.');
        }
        // Último recurso: el texto corto que sí devolvió pdf-parse
        if (String(textoDigital || '').trim() !== '') {
            console.warn('[ZET][Extracción] OCR sin resultado; se usa el texto corto de pdf-parse.');
            return { texto: textoDigital, metodo: 'pdf-digital' };
        }
        if (errorOcr) {
            throw new Error('No fue posible extraer el texto del documento (pdf-parse y OCR fallaron): ' +
                (errorOcr && errorOcr.message ? errorOcr.message : errorOcr));
        }
        throw new Error('No se pudo extraer texto del documento: el PDF no tiene capa de texto y el OCR no devolvió texto suficiente.');
    } finally {
        ZDK.Client.hideLoader();
    }
};

/* ===========================================================================
   PASO 1b) VALIDACIONES DETERMINISTAS DEL NÚMERO DE REGISTRO Y LA FECHA
   ---------------------------------------------------------------------------
   Reglas del instructivo "Validaciones pruebas saber" (ICFES). Se aplican en
   el widget, sin depender del LLM, porque son reglas de NEGOCIO verificables:

   Saber 11 (número de registro = código de la prueba):
     - Longitud 12 a 20, empieza por AC o VG (o "CONVENIO + código").
     - Long >= 14: los dígitos 3 a 6 son el año de presentación (> 1960).
     - Long == 12: si el dígito 3 es 1 o 2, los dígitos 4-5 son los 2 últimos
       dígitos de un año < 1996; si no, los dígitos 3-4 son los 2 últimos
       dígitos de un año >= 1996.
     - El año del código debe coincidir con el año de la FECHA DE APLICACIÓN.
     - Fecha aplicable solo a pregrado (posgrado usa Saber Pro en este widget).
   Saber Pro (número de registro = código de la prueba):
     - Empieza por EK seguido de números, longitud 14 a 20, o GRADOPOSTUMO.
     - Fecha de aplicación posterior al 14/10/2009.
     - "Anterior a la fecha de grado": el CRM no tiene ese dato todavía, así
       que se omite (ver opciones.fechaGrado en validarFechaSaberPro).

   La comparación del número de registro es ESTRICTA (sin tolerancia OCR):
   ahora solo se aceptan PDF, que tienen capa de texto.
   =========================================================================== */

export const TIPO_PRUEBA_SABER11 = 'saber11';
export const TIPO_PRUEBA_SABERPRO = 'saberpro';

// Mínimo de la fecha de aplicación de Saber Pro (instructivo ICFES).
const FECHA_MINIMA_SABER_PRO = '2009-10-14';
// Rango plausible de un año dentro del código (evita años absurdos por OCR).
const ANIO_MINIMO = 1900;
const ANIO_MAXIMO = 2200;

/** Nombre legible de cada tipo de prueba (para mensajes de error). */
const nombrePrueba = (tipo) => (tipo === TIPO_PRUEBA_SABERPRO ? 'Saber Pro' : 'Saber 11');

/**
 * Tipo de prueba que CORRESPONDE al tipo de programa:
 *   pregrado / tecnico -> Saber 11 (AC…/VG… o CONVENIO + código)
 *   postgrado          -> Saber Pro (EK… o gradopostumo)
 * Devuelve '' si el tipo de programa no se reconoce (no se puede exigir nada).
 *
 * Es la fuente de verdad de la validación: NO se deduce del campo de archivo
 * donde el usuario cargó el PDF, porque un usuario puede cargar el certificado
 * equivocado (p. ej. un EK de Saber Pro en una oportunidad de pregrado).
 */
export const tipoPruebaPorPrograma = (tipoPrograma) => {
    const p = normalizarTexto(tipoPrograma);
    if (p === 'postgrado' || p === 'posgrado') return TIPO_PRUEBA_SABERPRO;
    if (p === 'pregrado' || p === 'tecnico') return TIPO_PRUEBA_SABER11;
    return '';
};

/**
 * Tipo de prueba que sugiere el PREFIJO del código de registro:
 *   AC / VG / CONVENIO -> Saber 11
 *   EK / GRADOPOSTUMO  -> Saber Pro
 * Devuelve '' si el código está vacío o no se reconoce.
 */
export const tipoPruebaPorCodigo = (codigo) => {
    const c = normalizarNumeroRegistro(codigo);
    if (!c) return '';
    if (/^(AC|VG)/.test(c) || c.startsWith('CONVENIO')) return TIPO_PRUEBA_SABER11;
    if (/^EK/.test(c) || c === 'GRADOPOSTUMO') return TIPO_PRUEBA_SABERPRO;
    return '';
};

/**
 * Normaliza un número de registro: mayúsculas, sin acentos, sin espacios ni
 * separadores (puntos, guiones). Solo letras A-Z y dígitos.
 * Ej.: "ac 2018-2166.9035" -> "AC201821669035".
 */
export const normalizarNumeroRegistro = (valor) => String(valor === null || valor === undefined ? '' : valor)
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]/g, '');

/**
 * Extrae el NÚMERO DE REGISTRO (código ICFES) del texto del adjunto.
 *
 * Orden de búsqueda:
 *   1) Valor pegado a la etiqueta "Número de registro" (formatos 2020+).
 *   2) Cualquier código AC/VG/EK de 12 a 20 caracteres (certificados Saber Pro
 *      e informes antiguos, donde la etiqueta está en una cabecera de tabla).
 *   3) GRADOPOSTUMO.
 *   4) "CONVENIO + código" (examen internacional reconocido).
 *
 * Nunca devuelve la identificación (solo dígitos) ni DANE/SNIES (no empiezan
 * por AC/VG/EK), por eso no hacen falta listas de distractores.
 *
 * @param {string} texto
 * @returns {string} código normalizado o '' si no se encontró
 */
export const extraerNumeroRegistro = (texto) => {
    const t = String(texto === null || texto === undefined ? '' : texto);
    const conEtiqueta = t.match(/N[UÚ]MERO\s+DE\s+REGISTRO[^A-Z0-9]{0,40}((?:AC|VG|EK)[0-9]{10,18}|GRADOPOSTUMO)/i);
    if (conEtiqueta) return normalizarNumeroRegistro(conEtiqueta[1]);

    const codigo = t.match(/(?:AC|VG|EK)[0-9]{10,18}/i);
    if (codigo) return normalizarNumeroRegistro(codigo[0]);

    if (/GRADOPOSTUMO/i.test(t)) return 'GRADOPOSTUMO';

    const convenio = t.match(/CONVENIO\s*[:.+\-]?\s*([A-Z0-9][A-Z0-9.\-]*)/i);
    if (convenio) return normalizarNumeroRegistro('CONVENIO' + convenio[1]);

    return '';
};

/**
 * Año de presentación codificado en un código Saber 11 (AC/VG), según las
 * reglas del instructivo. Devuelve null si el código no permite determinarlo
 * (longitud 13, "CONVENIO ...", etc.).
 */
export const anioCodigoSaber11 = (codigo) => {
    const c = normalizarNumeroRegistro(codigo);
    if (!/^(AC|VG)[0-9]{10,18}$/.test(c)) return null;

    if (c.length >= 14) {
        const anio = Number(c.slice(2, 6));
        return (anio > ANIO_MINIMO && anio <= ANIO_MAXIMO) ? anio : null;
    }
    if (c.length === 12) {
        const digito3 = c[2];
        if (digito3 === '1' || digito3 === '2') {
            // Dígitos 4-5: 2 últimos dígitos de un año < 1996 -> 19xx
            return 1900 + Number(c.slice(3, 5));
        }
        // Dígitos 3-4: 2 últimos dígitos de un año >= 1996
        const yy = Number(c.slice(2, 4));
        return yy >= 96 ? 1900 + yy : 2000 + yy;
    }
    return null;
};

/** Valida la estructura del código Saber 11. */
export const validarRegistroSaber11 = (codigo) => {
    const errores = [];
    const c = normalizarNumeroRegistro(codigo);

    if (!c) {
        return { ok: false, errores: ['Ingrese el número de registro de la prueba Saber 11.'] };
    }
    // Caso especial del instructivo: examen internacional reconocido. No se
    // puede verificar el reconocimiento desde el widget, solo la forma.
    if (c.startsWith('CONVENIO')) {
        return { ok: true, errores: [] };
    }
    if (!/^(AC|VG)/.test(c)) {
        errores.push('El código Saber 11 debe empezar por AC o VG (o ser "CONVENIO + código").');
    }
    if (c.length < 12 || c.length > 20) {
        errores.push('El código Saber 11 debe tener entre 12 y 20 caracteres.');
    } else if (c.length >= 14) {
        const anio = Number(c.slice(2, 6));
        if (!(anio > 1960 && anio <= ANIO_MAXIMO)) {
            errores.push('En un código de 14 o más caracteres, los dígitos 3 a 6 deben ser un año mayor a 1960.');
        }
    } else if (c.length === 12) {
        const digito3 = c[2];
        if (digito3 === '1' || digito3 === '2') {
            const anio = 1900 + Number(c.slice(3, 5));
            if (!(anio < 1996)) {
                errores.push('Con 12 caracteres y dígito 3 igual a ' + digito3 +
                    ', los dígitos 4 y 5 deben ser los 2 últimos dígitos de un año menor a 1996.');
            }
        } else {
            const yy = Number(c.slice(2, 4));
            const anio = yy >= 96 ? 1900 + yy : 2000 + yy;
            if (!(anio >= 1996)) {
                errores.push('Con 12 caracteres y dígito 3 distinto de 1 o 2, los dígitos 3 y 4 deben ser los 2 últimos dígitos de un año mayor o igual a 1996.');
            }
        }
    }
    return { ok: errores.length === 0, errores: errores };
};

/** Valida la estructura del código Saber Pro. */
export const validarRegistroSaberPro = (codigo) => {
    const errores = [];
    const c = normalizarNumeroRegistro(codigo);

    if (!c) {
        return { ok: false, errores: ['Ingrese el número de registro de la prueba Saber Pro.'] };
    }
    if (c === 'GRADOPOSTUMO') return { ok: true, errores: [] };

    if (!/^EK[0-9]+$/.test(c)) {
        errores.push('El código Saber Pro debe empezar por EK seguido de números, o ser "gradopostumo".');
    } else if (c.length < 14 || c.length > 20) {
        errores.push('El código Saber Pro debe tener entre 14 y 20 caracteres.');
    }
    return { ok: errores.length === 0, errores: errores };
};

/** Parsea una fecha ISO 'AAAA-MM-DD' del input type="date". null si no es válida. */
export const parsearFechaISO = (valor) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(valor === null || valor === undefined ? '' : valor).trim());
    if (!m) return null;
    const anio = Number(m[1]);
    const mes = Number(m[2]);
    const dia = Number(m[3]);
    const fecha = new Date(Date.UTC(anio, mes - 1, dia));
    if (fecha.getUTCFullYear() !== anio || fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== dia) {
        return null;
    }
    return { anio: anio, mes: mes, dia: dia, iso: m[1] + '-' + m[2] + '-' + m[3] };
};

/**
 * Valida la FECHA DE APLICACIÓN contra el código Saber 11.
 *
 * Regla implementada sin periodo de reporte: el AÑO de la fecha debe coincidir
 * con el año codificado en el código de la prueba (es la parte de la regla que
 * se puede verificar con los datos que hoy tenemos).
 *
 * @param {string} fechaISO  valor del campo "Fecha de aplicación prueba"
 * @param {string} codigo    número de registro (preferiblemente el del adjunto)
 * @param {{periodoReporte?: string, esArticulacion?: boolean}} [opciones]
 *        periodoReporte (ej. "2026-1"): si se envía, además se exige que la
 *        fecha sea anterior al inicio del periodo (1 de enero o 1 de julio).
 */
export const validarFechaSaber11 = (fechaISO, codigo, opciones = {}) => {
    const errores = [];
    const fecha = parsearFechaISO(fechaISO);
    if (!fecha) {
        return { ok: false, errores: ['Ingrese una fecha de aplicación de la prueba válida (AAAA-MM-DD).'] };
    }

    const codigoNorm = normalizarNumeroRegistro(codigo);
    if (/^(AC|VG)[0-9]{10,18}$/.test(codigoNorm)) {
        if (codigoNorm.length >= 14) {
            const anioCodigo = Number(codigoNorm.slice(2, 6));
            if (anioCodigo !== fecha.anio) {
                errores.push('El año de la fecha de aplicación (' + fecha.anio +
                    ') no coincide con los dígitos 3 a 6 del código (' + anioCodigo + ').');
            }
        } else if (codigoNorm.length === 12) {
            const digito3 = codigoNorm[2];
            if (digito3 === '1' || digito3 === '2') {
                // Formato para años ANTERIORES a 1996: dígitos 4 y 5 = YY de 19YY.
                if (fecha.anio >= 1996) {
                    errores.push('El código tiene 12 caracteres y el dígito 3 es ' + digito3 +
                        ': ese formato exige un año de presentación menor a 1996, pero la fecha indica ' +
                        fecha.anio + '.');
                } else {
                    const yy = Number(codigoNorm.slice(3, 5));
                    if ((1900 + yy) !== fecha.anio) {
                        errores.push('Los dígitos 4 y 5 del código (' + codigoNorm.slice(3, 5) +
                            ') no corresponden al año de la fecha (' + fecha.anio + ').');
                    }
                }
            } else {
                // Formato para años 1996 o posteriores: dígitos 3 y 4 = YY.
                if (fecha.anio < 1996) {
                    errores.push('El código tiene 12 caracteres y el dígito 3 es ' + digito3 +
                        ': ese formato exige un año de presentación mayor o igual a 1996, pero la fecha indica ' +
                        fecha.anio + '.');
                } else {
                    const yy = Number(codigoNorm.slice(2, 4));
                    const anioCodigo = yy >= 96 ? 1900 + yy : 2000 + yy;
                    if (anioCodigo !== fecha.anio) {
                        errores.push('Los dígitos 3 y 4 del código (' + codigoNorm.slice(2, 4) +
                            ') no corresponden al año de la fecha (' + fecha.anio + ').');
                    }
                }
            }
        }
    }

    const periodo = String(opciones && opciones.periodoReporte || '').trim();
    if (periodo !== '') {
        const m = periodo.match(/^(\d{4})\s*[-/ ]?\s*([12])/);
        if (m) {
            const anioReporte = Number(m[1]);
            const semestre = Number(m[2]);
            const inicio = semestre === 1 ? anioReporte + '-01-01' : anioReporte + '-07-01';
            // Excepción de articulación (programas técnicos): se permite que la
            // fecha esté dentro del mismo periodo de reporte.
            const esArticulacion = !!(opciones && opciones.esArticulacion);
            if (!esArticulacion && fecha.iso >= inicio) {
                errores.push('La fecha de aplicación debe ser anterior al inicio del periodo de reporte (' +
                    inicio + ').');
            }
        }
    }
    return { ok: errores.length === 0, errores: errores };
};

/**
 * Valida la FECHA DE APLICACIÓN de Saber Pro: posterior al 14/10/2009 y, si se
 * conoce, anterior a la fecha de grado.
 */
export const validarFechaSaberPro = (fechaISO, opciones = {}) => {
    const errores = [];
    const fecha = parsearFechaISO(fechaISO);
    if (!fecha) {
        return { ok: false, errores: ['Ingrese una fecha de aplicación de la prueba válida (AAAA-MM-DD).'] };
    }
    if (fecha.iso <= FECHA_MINIMA_SABER_PRO) {
        errores.push('La fecha de aplicación de Saber Pro debe ser posterior al 14/10/2009.');
    }
    const fechaGrado = parsearFechaISO(opciones && opciones.fechaGrado);
    if (fechaGrado && fecha.iso >= fechaGrado.iso) {
        errores.push('La fecha de aplicación de Saber Pro debe ser anterior a la fecha de grado.');
    }
    return { ok: errores.length === 0, errores: errores };
};

/**
 * Validación COMPLETA (determinista) del adjunto de pruebas Saber:
 *   0) el TIPO DE PRUEBA lo exige el TIPO DE PROGRAMA (pregrado -> Saber 11,
 *      postgrado -> Saber Pro). Un código o certificado del otro tipo se
 *      rechaza aunque coincida con el diligenciado y con el documento;
 *   1) extrae el número de registro del texto del PDF;
 *   2) lo compara con el valor diligenciado por el usuario;
 *   3) valida la estructura del código;
 *   4) valida la fecha de aplicación contra el código.
 *
 * @param {{tipoPrueba?: string, tipoPrograma?: string, numeroRegistro?: string,
 *          fechaAplicacion?: string, textoDocumento?: string,
 *          periodoReporte?: string, fechaGrado?: string}} datos
 *        tipoPrograma ('pregrado' | 'postgrado' | 'tecnico') es obligatorio
 *        para poder exigir el formato correcto. tipoPrueba indica el campo de
 *        archivo usado (saber11/saberpro) y solo sirve para detectar que el
 *        PDF se cargó en el campo equivocado.
 * @returns {{status: 'ok'|'invalid'|'unknown', message: string,
 *            registro: string, errores: string[]}}
 */
export const validarDatosPrueba = (datos = {}) => {
    const tipoPrograma = normalizarTexto(datos.tipoPrograma);
    // Tipo de prueba EXIGIDO por el programa: es la fuente de verdad de toda la
    // validación. Nunca se deduce del campo de archivo donde el usuario cargó el
    // PDF, porque podría cargar el certificado del otro tipo de prueba.
    const tipoEsperado = tipoPruebaPorPrograma(tipoPrograma);
    const tipoDelAdjunto = normalizarTexto(datos.tipoPrueba) === TIPO_PRUEBA_SABERPRO
        ? TIPO_PRUEBA_SABERPRO : TIPO_PRUEBA_SABER11;
    const tipo = tipoEsperado || tipoDelAdjunto;
    const esSaberPro = tipo === TIPO_PRUEBA_SABERPRO;
    const diligenciado = normalizarNumeroRegistro(datos.numeroRegistro);
    const texto = typeof datos.textoDocumento === 'string' ? datos.textoDocumento : '';
    const registroAdjunto = extraerNumeroRegistro(texto);
    const errores = [];

    // 0) Coherencia programa ↔ campo del adjunto: pregrado usa Saber 11 y
    //    postgrado usa Saber Pro. Un PDF cargado en el campo de la otra prueba
    //    se rechaza siempre.
    if (tipoEsperado && tipoDelAdjunto !== tipoEsperado) {
        errores.push('El programa es de ' +
            (esSaberPro ? 'postgrado y corresponde a la prueba Saber Pro' : 'pregrado y corresponde a la prueba Saber 11') +
            ', pero el adjunto se cargó en el campo de ' + nombrePrueba(tipoDelAdjunto) + '.');
    }

    // 1) Estructura del valor diligenciado. Si el usuario escribió un código del
    //    OTRO tipo de prueba (p. ej. un EK en una oportunidad de pregrado), se
    //    informa explícitamente en lugar del error genérico de estructura.
    const tipoCodigoDiligenciado = tipoPruebaPorCodigo(diligenciado);
    const diligenciadoDeOtroTipo = !!(tipoEsperado && tipoCodigoDiligenciado &&
        tipoCodigoDiligenciado !== tipoEsperado);
    if (diligenciadoDeOtroTipo) {
        errores.push('El número de registro diligenciado (' + diligenciado + ') es un código de ' +
            nombrePrueba(tipoCodigoDiligenciado) + ', pero el programa es de ' +
            (esSaberPro ? 'postgrado' : 'pregrado') + ' y exige un código de ' +
            nombrePrueba(tipoEsperado) + ' (' +
            (esSaberPro ? 'EK… o gradopostumo' : 'AC…, VG… o CONVENIO + código') + ').');
    } else {
        const estructuraDiligenciado = esSaberPro
            ? validarRegistroSaberPro(diligenciado)
            : validarRegistroSaber11(diligenciado);
        errores.push(...estructuraDiligenciado.errores);
    }

    // 2) Sin número de registro legible en el PDF no se puede confirmar nada
    if (!registroAdjunto) {
        const unicos = Array.from(new Set(errores));
        return {
            status: 'unknown',
            message: 'No se pudo leer el número de registro de la prueba en el adjunto. Verifique que el PDF sea el documento correcto e intente de nuevo.',
            registro: '',
            errores: unicos
        };
    }

    // 3) El número del adjunto debe coincidir EXACTAMENTE con el diligenciado
    if (diligenciado && registroAdjunto !== diligenciado) {
        errores.push('El número de registro del adjunto (' + registroAdjunto +
            ') no coincide con el diligenciado (' + diligenciado + ').');
    }

    // 4) Estructura del código LEÍDO del adjunto. Si el certificado es del otro
    //    tipo de prueba, el error lo dice explícitamente.
    const tipoCodigoAdjunto = tipoPruebaPorCodigo(registroAdjunto);
    if (tipoEsperado && tipoCodigoAdjunto && tipoCodigoAdjunto !== tipoEsperado) {
        errores.push('El adjunto corresponde a ' + nombrePrueba(tipoCodigoAdjunto) +
            ' (' + registroAdjunto + '), pero el programa es de ' +
            (esSaberPro ? 'postgrado' : 'pregrado') + ' y exige ' +
            nombrePrueba(tipoEsperado) + ': adjunte el certificado correcto.');
    } else {
        const estructuraAdjunto = esSaberPro
            ? validarRegistroSaberPro(registroAdjunto)
            : validarRegistroSaber11(registroAdjunto);
        for (const error of estructuraAdjunto.errores) {
            if (!errores.includes(error)) errores.push('En el adjunto: ' + error);
        }
    }

    // 5) Fecha de aplicación vs código
    const opcionesFecha = {
        periodoReporte: datos.periodoReporte,
        esArticulacion: tipoPrograma === 'tecnico'
    };
    const validacionFecha = esSaberPro
        ? validarFechaSaberPro(datos.fechaAplicacion, { fechaGrado: datos.fechaGrado })
        : validarFechaSaber11(datos.fechaAplicacion, registroAdjunto, opcionesFecha);
    errores.push(...validacionFecha.errores);

    // 5b) Si el usuario diligenció un código distinto al del adjunto, también se
    // valida ESE código contra la fecha: así se alerta, por ejemplo, de un código
    // de 12 caracteres con dígito 3 = 1 o 2 cuando la fecha es de 1996 o posterior
    // (ese formato solo aplica a años anteriores a 1996).
    if (!esSaberPro && !diligenciadoDeOtroTipo && diligenciado && diligenciado !== registroAdjunto &&
        parsearFechaISO(datos.fechaAplicacion)) {
        const validacionFechaDiligenciado = validarFechaSaber11(
            datos.fechaAplicacion, diligenciado, opcionesFecha);
        for (const error of validacionFechaDiligenciado.errores) {
            const conContexto = 'En el número de registro diligenciado: ' + error;
            if (!errores.includes(conContexto)) errores.push(conContexto);
        }
    }

    const unicos = Array.from(new Set(errores));
    console.log('[ZET][Pruebas] Programa:', tipoPrograma || '(no indicado)',
        '| prueba exigida:', tipoEsperado || '(según el campo)',
        '| registro del adjunto:', registroAdjunto || '(no encontrado)',
        '| diligenciado:', diligenciado || '(vacío)', '| errores:', unicos.length);
    return {
        status: unicos.length === 0 ? 'ok' : 'invalid',
        message: unicos.join(' '),
        registro: registroAdjunto,
        errores: unicos
    };
};


/**
 * Id de sesión del agente (header X-ZIAAGENTS-AGENT-SESSION-ID).
 * REGLA: es el ID DE LA OPORTUNIDAD (deal id), igual que en el ejemplo
 * adjunto (donde se usaba el id del registro/ticket). Solo si por algún
 * motivo no hubiera deal id disponible se genera un id alternativo.
 */
const obtenerIdSesionAgente = (dealId) => {
    if (dealId !== undefined && dealId !== null && String(dealId).trim() !== '') {
        return String(dealId).trim();
    }
    const idOportunidad = getContactInfo().entityId;
    if (idOportunidad !== undefined && idOportunidad !== null && String(idOportunidad).trim() !== '') {
        return String(idOportunidad).trim();
    }
    // Último recurso (no debería ocurrir): id generado en el cliente
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return 'sesion-' + Date.now() + '-' + Math.random().toString(16).slice(2);
};

/**
 * Arma el contenido de la llave "query" del body del agente.
 *
 * ─── ÚNICO PUNTO DE AJUSTE del texto que recibe el agente ───
 * Formato actual (requisito previo: el agente necesita el número de documento
 * del estudiante para compararlo con el contenido del adjunto):
 *
 *     Número de documento del estudiante: <doc>
 *
 *     Texto del documento adjunto:
 *     <textoExtraido>
 *
 * Si se prefiriera enviar SOLO el texto del adjunto, se cambia aquí.
 *
 * @param {string} textoExtraido  texto devuelto por extraerTextoDocumento()
 * @param {string|number} numeroDocumento  número de documento del estudiante
 * @returns {string} contenido de "query"
 */
export const construirQuery = (textoExtraido, numeroDocumento, contexto = {}) => {
    const doc = (numeroDocumento === undefined || numeroDocumento === null) ? '' : String(numeroDocumento).trim();
    let texto = (textoExtraido === undefined || textoExtraido === null) ? '' : String(textoExtraido).trim();
    if (texto.length > MAX_CARACTERES_QUERY) {
        console.warn('[ZET][Agente] Texto del adjunto demasiado largo (' + texto.length +
            ' caracteres); se recorta a ' + MAX_CARACTERES_QUERY + '.');
        texto = texto.slice(0, MAX_CARACTERES_QUERY) + '\n[...texto truncado...]';
    }
    const ctx = contexto || {};
    const dato = (v) => (v === undefined || v === null) ? '' : String(v).trim();
    // Cabecera con el contexto del formulario. Si no se pasa contexto, el query
    // conserva EXACTAMENTE el formato anterior (compatibilidad con las pruebas).
    const lineas = ['Número de documento del estudiante: ' + doc];
    if (dato(ctx.tipoPrograma)) lineas.push('Tipo de programa: ' + dato(ctx.tipoPrograma));
    if (dato(ctx.tipoPrueba)) lineas.push('Tipo de prueba: ' + dato(ctx.tipoPrueba));
    if (dato(ctx.numeroRegistro)) lineas.push('Número de registro diligenciado: ' + dato(ctx.numeroRegistro));
    if (dato(ctx.fechaAplicacion)) lineas.push('Fecha de aplicación de la prueba: ' + dato(ctx.fechaAplicacion));
    return lineas.join('\n') + '\n\nTexto del documento adjunto:\n' + texto;
};

/**
 * PASO B) Dispara la validación con el agente de Zia Agents.
 *
 * La llamada replica el ejemplo y la documentación de la "API de agente"
 * (POST .../agents/<agent-id>/trigger):
 *   headers : X-ZIAAGENTS-ORG, X-ZIAAGENTS-AGENT-SESSION-ID (= id de la
 *             oportunidad) y Content-Type: application/json. El header
 *             Authorization: Zoho-oauthtoken <access-token> lo agrega ZRC
 *             desde la conexión ZIAAGENTS_CONNECTION.
 *   body    : { query, systemArgs:{}, reasoning:false }   -> SIN "attachments"
 *             (el contenido del adjunto viaja dentro de "query" como texto).
 *
 * @param {string} textoExtraido  texto devuelto por extraerTextoDocumento()
 * @param {object} [options]  { doc, programa, dealId, tipoPrograma, tipoPrueba,
 *                             numeroRegistro, fechaAplicacion }
 * @returns {Promise<{response: object, sessionId: string}>}
 */
export const triggerValidationAgent = async (textoExtraido, options = {}) => {
    // X-ZIAAGENTS-AGENT-SESSION-ID = id de la oportunidad
    const sessionId = obtenerIdSesionAgente(options.dealId);
    const doc = (options.doc !== undefined && options.doc !== null && options.doc !== '') ? options.doc : getGlobalDoc();
    const programa = options.programa || getGlobalPrograma();

    const body = {
        // Texto armado por construirQuery(): número de documento + contexto del
        // formulario (programa, registro, fecha) + texto del adjunto
        query: construirQuery(textoExtraido, doc, {
            tipoPrograma: options.tipoPrograma,
            tipoPrueba: options.tipoPrueba,
            numeroRegistro: options.numeroRegistro,
            fechaAplicacion: options.fechaAplicacion
        }),
        systemArgs: {},
        reasoning: false
        // Sin "attachments": el adjunto NO se sube a ZFS en este flujo
    };

    console.log('[ZET][Agente] Disparando validación. oportunidad:', sessionId, '| programa:', programa,
        '| caracteres del query:', body.query.length);

    ZDK.Client.showLoader({
        type: 'page',
        template: 'vertical-bar',
        message: 'Validando documento con el agente...'
    });
    try {
        const response = await zrc.request({
            method: 'POST',
            path: ZIAAGENTS_TRIGGER_URL,
            headers: {
                // Igual que el ejemplo y la documentación de la API de agente
                'X-ZIAAGENTS-ORG': ZIAAGENTS_ORG_ID,
                // ID de la OPORTUNIDAD (deal id) usada como id de sesión
                'X-ZIAAGENTS-AGENT-SESSION-ID': sessionId,
                'Content-Type': 'application/json'
                // Authorization: "Zoho-oauthtoken <access-token>" lo inyecta ZRC
                // desde la conexión ZIAAGENTS_CONNECTION (ver constante).
            },
            body: body,
            connection: ZIAAGENTS_CONNECTION
        });
        verificarRespuestaZrc(response, 'Zia Agents');
        return { response: response, sessionId: sessionId };
    } finally {
        ZDK.Client.hideLoader();
    }
};

/** Extrae el texto de la respuesta del agente sin importar el formato exacto. */
const extraerTextoRespuestaAgente = (raw) => {
    if (raw === null || raw === undefined) return '';
    if (typeof raw === 'string') return raw.trim();
    if (typeof raw !== 'object') return '';

    // Rutas típicas, de mayor a menor prioridad (zrc envuelve el body HTTP en .data)
    const rutas = [
        ['data', 'data', 'response'],   // { data: { data: { response } } }
        ['data', 'response'],           // { data: { response } }  (formato documentado)
        ['response'],                   // { response }
        ['data', 'data', 'message'],
        ['data', 'message'],
        ['data', 'data'],               // el valor directo podría ser el texto
        ['data'],
        ['message']                     // mensaje a nivel de envelope (último recurso)
    ];
    for (const ruta of rutas) {
        let valor = raw;
        for (const paso of ruta) {
            valor = (valor && typeof valor === 'object') ? valor[paso] : undefined;
            if (valor === undefined || valor === null) break;
        }
        if (typeof valor === 'string' && valor.trim() !== '') return valor.trim();
    }

    // Último recurso: concatenar los textos encontrados (profundidad máxima 4)
    const cola = [{ nodo: raw, prof: 0 }];
    const textos = [];
    while (cola.length) {
        const actual = cola.shift();
        if (!actual.nodo || typeof actual.nodo !== 'object') continue;
        for (const valor of Object.values(actual.nodo)) {
            if (typeof valor === 'string' && valor.trim() !== '') textos.push(valor.trim());
            else if (valor && typeof valor === 'object' && actual.prof < 4) cola.push({ nodo: valor, prof: actual.prof + 1 });
        }
    }
    return textos.join(' ').trim();
};

/* Flags estructurados: { valid:false }, { success:false }, { status:"INVALID" }, etc.
   Se recorre el objeto y "invalid" siempre tiene prioridad sobre "valid". */
const ESTADOS_INVALIDOS = ['invalid', 'failed', 'failure', 'rejected', 'reject', 'mismatch', 'not_valid', 'notvalid', 'unsuccessful'];
const ESTADOS_VALIDOS = ['valid', 'success', 'successful', 'approved', 'approve', 'passed', 'matched', 'match', 'ok'];

const detectarFlagEstructurado = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    // Se recorre el body HTTP (raw.data) y, si no lo hay, la respuesta completa
    const inicial = (raw.data && typeof raw.data === 'object') ? raw.data : raw;
    const cola = [{ nodo: inicial, prof: 0 }];
    let hallazgo = null;
    while (cola.length) {
        const actual = cola.shift();
        if (!actual.nodo || typeof actual.nodo !== 'object') continue;
        for (const clave of Object.keys(actual.nodo)) {
            const valor = actual.nodo[clave];
            const k = normalizarTexto(clave);
            if (typeof valor === 'boolean') {
                if (['valid', 'is_valid', 'isvalid', 'success', 'matched', 'match', 'approved'].includes(k)) {
                    if (valor === false) return 'invalid';
                    if (hallazgo === null) hallazgo = 'valid';
                }
            } else if (typeof valor === 'string' && ['status', 'result', 'state', 'verdict'].includes(k)) {
                const v = normalizarTexto(valor).trim();
                if (ESTADOS_INVALIDOS.includes(v)) return 'invalid';
                if (hallazgo === null && ESTADOS_VALIDOS.includes(v)) hallazgo = 'valid';
            } else if (valor && typeof valor === 'object' && actual.prof < 4) {
                cola.push({ nodo: valor, prof: actual.prof + 1 });
            }
        }
    }
    return hallazgo;
};

const recortarTexto = (texto, max) => (texto.length > max ? texto.slice(0, max) + '...' : texto);

/* ===========================================================================
   RESPUESTA JSON DEL AGENTE (fuente PRINCIPAL de la decisión)
   ---------------------------------------------------------------------------
   El agente de Zia Agents responde SIEMPRE con este JSON (posiblemente
   envuelto en ```json ... ``` o con texto antes/después del objeto):

     {
       "estado_definitivo": "válido|no válido",
       "documento_estudiante": "número_extraído",
       "tipo_documento": "Saber 11|Saber Pro|No reconocido",
       "coincidencia_identidad": true|false,
       "numero_registro_adjunto": "código_extraído o NO_ENCONTRADO",
       "numero_registro_diligenciado": "código del formulario o vacío",
       "coincidencia_registro": true|false,
       "validacion_codigo": "ok|invalida|no_evaluada",
       "validacion_fecha": "ok|invalida|no_evaluada",
       "errores": ["reglas incumplidas"],
       "justificacion": "Explicación concisa (máximo 2 líneas) de los hallazgos."
     }

   Los campos de registro/fecha son INFORMATIVOS: la decisión del widget sigue
   siendo "estado_definitivo" + "coincidencia_identidad" y, además, las reglas
   deterministas de validarDatosPrueba() (PASO 1b), que se aplican aunque el
   agente omita esos campos.

   REGLAS DE DECISIÓN (orden de PRECEDENCIA, implementadas en
   evaluarRespuestaJson()):
     1. coincidencia_identidad === false -> NO VÁLIDO (bloquea): el adjunto NO
        coincide con el número de documento del estudiante.
     2. tipo_documento === "No reconocido" -> NO VÁLIDO (bloquea): el agente no
        logró reconocer el documento. (Constante TIPO_DOC_NO_RECONOCIDO: si se
        prefiere otra conducta, cambiar aquí.)
     3. estado_definitivo normalizado (minúsculas y SIN acentos) "no válido"
        -> NO VÁLIDO (bloquea).
     4. estado_definitivo "válido" + coincidencia_identidad === true -> VÁLIDO
        (la coincidencia TRUE es REQUISITO para que sea válido).
     5. estado "válido" sin coincidencia confirmada, o estado no reconocido
        -> 'unknown' (bloquea; NUNCA se asume válido).

   La "justificacion" es lo que se muestra al usuario en #mensaje-error
   cuando la validación NO permite enviar (status 'invalid' o 'unknown'); si
   viniera vacía se usa un texto genérico de respaldo.

   Si el JSON viene mal formado, no trae "estado_definitivo" o la respuesta no
   es JSON, evaluarRespuestaJson() devuelve null y evaluateAgentResponse()
   continúa con el FLUJO DE RESPALDO de siempre (flags estructurados +
   PALABRAS_CLAVE_* + PATRON_NEGACION -> 'unknown' si nada interpreta).
   =========================================================================== */

// Valores del JSON comparados con normalizarTexto() (minúsculas y sin acentos)
const ESTADO_DEF_JSON_VALIDO = normalizarTexto('válido');        // -> "valido"
const ESTADO_DEF_JSON_NO_VALIDO = normalizarTexto('no válido');  // -> "no valido"
const TIPO_DOC_NO_RECONOCIDO = normalizarTexto('No reconocido'); // -> "no reconocido"
// Textos genéricos cuando el agente NO envía "justificacion" (o el JSON no viene)
const MSG_JSON_INVALIDA_GENERICA = 'El agente de validación indicó que el documento adjunto NO es válido para el número de documento del estudiante.';
const MSG_JSON_DESCONOCIDA_GENERICA = 'No se pudo determinar la validez del documento. Vuelva a seleccionar el archivo para reintentar.';
// El agente no logró LEER la identificación (típico de una imagen borrosa):
// no es prueba de invalidez, así que se trata como 'unknown' (permite reintentar).
const MSG_JSON_SIN_IDENTIFICACION = 'No se pudo leer el número de documento del adjunto. Cargue una imagen más nítida o use "Reintentar validación".';
// Tope de caracteres de la justificación que se pinta en la UI
const MAX_CARACTERES_JUSTIFICACION = 500;

/**
 * Extrae el primer bloque {...} equilibrado que empieza en `inicio`
 * (respeta llaves dentro de cadenas y escapes de comillas).
 * @param {string} texto
 * @param {number} índice del '{' inicial
 * @returns {string|null}
 */
const extraerBloqueJsonEquilibrado = (texto, inicio) => {
    let profundidad = 0;
    let enCadena = false;
    let escape = false;
    for (let i = inicio; i < texto.length; i++) {
        const ch = texto[i];
        if (enCadena) {
            if (escape) escape = false;
            else if (ch === '\\') escape = true;
            else if (ch === '"') enCadena = false;
            continue;
        }
        if (ch === '"') enCadena = true;
        else if (ch === '{') profundidad++;
        else if (ch === '}') {
            profundidad--;
            if (profundidad === 0) return texto.slice(inicio, i + 1);
        }
    }
    // Sin cierre equilibrado (JSON truncado): hasta la última llave '}' y que
    // el caller intente parsear (si falla, se va al flujo de respaldo).
    const fin = texto.lastIndexOf('}');
    return fin > inicio ? texto.slice(inicio, fin + 1) : null;
};

/**
 * Intenta obtener el JSON del agente a partir de un string: JSON puro o JSON
 * embebido en texto (con ```json ... ``` o con texto antes/después).
 * @returns {object|null}
 */
const parsearTextoJsonAgente = (texto) => {
    // Quita los fences de bloques de código (```json / ```)
    const limpio = String(texto === null || texto === undefined ? '' : texto)
        .replace(/```[a-zA-Z]*/g, '')
        .trim();
    if (limpio === '') return null;

    // 1) El string ya es JSON puro
    try {
        const directo = JSON.parse(limpio);
        if (directo && typeof directo === 'object') return directo;
    } catch (e) {
        // no era JSON puro: se busca el objeto dentro del texto
    }

    // 2) Objeto embebido: desde el primer '{' hasta su '} equilibrado'
    let desde = 0;
    for (let intento = 0; intento < 5; intento++) {
        const inicio = limpio.indexOf('{', desde);
        if (inicio === -1) break;
        const bloque = extraerBloqueJsonEquilibrado(limpio, inicio);
        if (!bloque) break;
        try {
            const parsed = JSON.parse(bloque);
            if (parsed && typeof parsed === 'object') return parsed;
        } catch (e) {
            // bloque no válido: se intenta con el siguiente '{'
        }
        desde = inicio + 1;
    }
    return null;
};

/**
 * Localiza y parsea el JSON del agente dentro de la respuesta cruda de zrc.
 * Tolera: objeto ya parseado (zrc devolvió "data" como objeto), string JSON
 * puro, string con ```json ... ``` y string con texto antes/después del objeto.
 *
 * @param {object|string} raw respuesta cruda de triggerValidationAgent
 * @returns {object|null} objeto parseado o null (=> flujo de respaldo)
 */
export const parsearJsonAgente = (raw) => {
    if (raw === null || raw === undefined) return null;

    // a) Objeto ya parseado: se busca el nodo que contenga "estado_definitivo"
    if (typeof raw === 'object') {
        const cola = [{ nodo: raw, prof: 0 }];
        while (cola.length) {
            const actual = cola.shift();
            if (!actual.nodo || typeof actual.nodo !== 'object') continue;
            if (Object.prototype.hasOwnProperty.call(actual.nodo, 'estado_definitivo')) {
                return actual.nodo;
            }
            if (actual.prof < 5) {
                for (const valor of Object.values(actual.nodo)) {
                    if (valor && typeof valor === 'object') cola.push({ nodo: valor, prof: actual.prof + 1 });
                }
            }
        }
    }

    // b) String (directo o envuelto en el body de zrc)
    const texto = extraerTextoRespuestaAgente(raw);
    if (!texto) return null;
    return parsearTextoJsonAgente(texto);
};

/**
 * Evalúa el JSON del agente contra las REGLAS DE DECISIÓN (ver cabecera de
 * esta sección). La "justificacion" se devuelve como `message` en los casos
 * bloqueantes ('invalid' y 'unknown') para que se muestre en #mensaje-error.
 *
 * @param {object} json objeto parseado que SÍ trae "estado_definitivo"
 * @returns {{status:'valid'|'invalid'|'unknown', message:string,
 *            estado:string, tipoDocumento:string|null, coincidencia:*,
 *            justificacion:string}|null}
 *          null => el JSON no sirve para decidir (usa el flujo de respaldo)
 */
export const evaluarRespuestaJson = (json, contexto = {}) => {
    if (!json || typeof json !== 'object') return null;

    const estadoCrudo = json.estado_definitivo;
    // Sin estado_definitivo -> el JSON no decide: flujo de respaldo
    if (estadoCrudo === undefined || estadoCrudo === null || String(estadoCrudo).trim() === '') return null;

    // --- campos clave del JSON -------------------------------------------
    const estado = String(estadoCrudo).trim();
    const estadoNorm = normalizarTexto(estado).replace(/[.,;:]+$/, '').trim();
    const tipoDocumento = (json.tipo_documento === undefined || json.tipo_documento === null)
        ? '' : String(json.tipo_documento).trim();
    const coincidencia = json.coincidencia_identidad;
    const documentoEstudiante = (json.documento_estudiante === undefined || json.documento_estudiante === null)
        ? '' : String(json.documento_estudiante).trim();
    const justificacion = (typeof json.justificacion === 'string') ? json.justificacion.trim() : '';

    // La justificación (o un texto genérico de respaldo) es lo que verá el
    // usuario cuando el botón de enviar quede deshabilitado.
    const mensajeInvalida = justificacion
        ? recortarTexto(justificacion, MAX_CARACTERES_JUSTIFICACION)
        : MSG_JSON_INVALIDA_GENERICA;
    const mensajeDesconocida = justificacion
        ? recortarTexto(justificacion, MAX_CARACTERES_JUSTIFICACION)
        : MSG_JSON_DESCONOCIDA_GENERICA;
    const mensajeSinIdentificacion = justificacion
        ? recortarTexto(justificacion, MAX_CARACTERES_JUSTIFICACION)
        : MSG_JSON_SIN_IDENTIFICACION;

    // El agente puede devolver booleanos o strings ("true"/"false"/"sí")
    const esFalse = (v) => v === false || normalizarTexto(v) === 'false' ||
        normalizarTexto(v) === 'no' || normalizarTexto(v) === '0';
    const esTrue = (v) => v === true || normalizarTexto(v) === 'true' ||
        normalizarTexto(v) === 'si' || normalizarTexto(v) === 's' || normalizarTexto(v) === '1';

    // {status, message} + campos extra (estado, tipoDocumento, coincidencia,
    // justificacion) para dejarlos en agentValidation sin romper la forma actual
    const resultado = (status, message) => ({
        status: status,
        message: message,
        estado: estado,
        tipoDocumento: tipoDocumento || null,
        coincidencia: (coincidencia === undefined ? null : coincidencia),
        justificacion: justificacion
    });

    // REGLA 0: el agente NO pudo LEER la identificación (OCR insuficiente).
    // No es prueba de que el documento sea inválido: se marca 'unknown' para
    // que el widget ofrezca "Reintentar validación" y el usuario pueda cargar
    // una imagen más nítida, en vez de un 'invalid' sin salida.
    if (documentoEstudiante.replace(/[\s_]+/g, '').toLowerCase() === 'noencontrado') {
        console.warn('[ZET][Agente] JSON: documento_estudiante = NO_ENCONTRADO -> UNKNOWN (posible fallo de OCR).');
        return resultado('unknown', mensajeSinIdentificacion);
    }

    // REGLA 1: el adjunto NO coincide con el número de documento -> bloquea
    if (esFalse(coincidencia)) {
        console.error('[ZET][Agente] JSON: coincidencia_identidad = false -> NO VÁLIDO. documento_estudiante:', documentoEstudiante);
        return resultado('invalid', mensajeInvalida);
    }
    // REGLA 2: el agente no reconoció el documento -> bloquea (ajustable:
    // constante TIPO_DOC_NO_RECONOCIDO)
    if (tipoDocumento !== '' && normalizarTexto(tipoDocumento) === TIPO_DOC_NO_RECONOCIDO) {
        console.error('[ZET][Agente] JSON: tipo_documento "No reconocido" -> NO VÁLIDO. documento_estudiante:', documentoEstudiante);
        return resultado('invalid', mensajeInvalida);
    }
    // REGLA 3: estado_definitivo "no válido" -> bloquea
    if (estadoNorm === ESTADO_DEF_JSON_NO_VALIDO) {
        console.error('[ZET][Agente] JSON: estado_definitivo "no válido" -> NO VÁLIDO. documento_estudiante:', documentoEstudiante);
        return resultado('invalid', mensajeInvalida);
    }
    // REGLA 4: estado "válido" + coincidencia confirmada -> VÁLIDO (message '')
    if (estadoNorm === ESTADO_DEF_JSON_VALIDO) {
        if (esTrue(coincidencia)) {
            // REGLA 4.1 — VERIFICACIÓN DETERMINISTA ANTES DE ACEPTAR.
            // El LLM puede afirmar coincidencia_identidad: true aunque los
            // números difieran (caso real: CRM 103707777 vs documento
            // 1026591722). Si tenemos el documento del CRM y el agente informa
            // el número leído, se comparan aquí, sin confiar en el booleano.
            const crmDigitos = normalizarCandidatoIdentidad(
                (contexto.documentoCrm !== undefined && contexto.documentoCrm !== null && contexto.documentoCrm !== '')
                    ? contexto.documentoCrm
                    : getGlobalDoc()
            );
            const documentoLeido = normalizarCandidatoIdentidad(documentoEstudiante);
            const crmVerificable = crmDigitos.length >= 6 && crmDigitos.length <= 11;
            if (crmVerificable) {
                if (!documentoLeido) {
                    console.error('[ZET][Agente] JSON: el agente dice "válido" pero NO informó documento_estudiante; no se puede verificar -> UNKNOWN.');
                    return resultado('unknown', 'El agente no informó el número de documento leído; no se puede verificar la coincidencia con la oportunidad. Reintente la validación.');
                }
                if (documentoLeido !== crmDigitos) {
                    // El agente leyó un número distinto. Antes de rechazar, se
                    // comprueba la extracción LOCAL del mismo texto: si esa sí
                    // coincide exacta con el CRM, el error fue del agente (OCR
                    // del LLM) y la identidad está confirmada.
                    const textoLocal = (typeof contexto.textoDocumento === 'string') ? contexto.textoDocumento : '';
                    const candidatoLocal = textoLocal ? extraerCandidatoIdentidad(textoLocal) : '';
                    if (candidatoLocal && candidatoLocal === crmDigitos) {
                        console.warn('[ZET][Agente] El agente informó "' + documentoLeido +
                            '" pero la extracción local coincide con el CRM ("' + crmDigitos + '"). Se acepta la verificación local.');
                    } else {
                        console.error('[ZET][Agente] VERIFICACIÓN LOCAL: documento del adjunto (' + documentoLeido +
                            ') != documento del CRM (' + crmDigitos + '). Se rechaza aunque el agente diga válido.');
                        return resultado('invalid', 'El número de documento del adjunto (' + documentoLeido +
                            ') no coincide con el registrado en la oportunidad (' + crmDigitos + '). Verifique el archivo.');
                    }
                }
            }
            console.log('[ZET][Agente] JSON: estado_definitivo "válido" + coincidencia_identidad true -> VÁLIDO. documento_estudiante:', documentoEstudiante);
            return resultado('valid', '');
        }
        // REGLA 5: dice "válido" pero la coincidencia NO está confirmada -> bloquea
        console.warn('[ZET][Agente] JSON: estado "válido" sin coincidencia_identidad === true -> UNKNOWN. documento_estudiante:', documentoEstudiante);
        return resultado('unknown', mensajeDesconocida);
    }
    // REGLA 6: estado no reconocido (p. ej. "en revisión") -> bloquea
    console.warn('[ZET][Agente] JSON: estado_definitivo no reconocido ("' + estado + '") -> UNKNOWN. documento_estudiante:', documentoEstudiante);
    return resultado('unknown', mensajeDesconocida);
};

/**
 * Verificación INDEPENDIENTE del agente sobre el TEXTO que se le envió.
 *
 * El LLM puede afirmar `coincidencia_identidad: true` aunque los números
 * difieran (caso real: CRM 103707777 vs documento 1026591722). Por eso, antes
 * de aceptar un 'valid', se extrae el número de identificación del texto con
 * `extraerCandidatoIdentidad()` y se compara con el documento del CRM:
 *   - candidato distinto del CRM -> 'invalid' (aunque el agente diga válido)
 *   - candidato igual al CRM     -> se respeta la decisión del agente
 *   - sin candidato o sin CRM    -> se respeta la decisión del agente
 * Esto también cubre las respuestas de TEXTO PLANO ("el documento es válido"),
 * que no traen número y por tanto no se pueden contrastar de otra forma.
 *
 * @param {{status:string,message:string}} resultado decisión del agente
 * @param {{textoDocumento?:string, documentoCrm?:string}} contexto
 */
const aplicarVerificacionLocal = (resultado, contexto = {}) => {
    if (!resultado || resultado.status !== 'valid') return resultado;

    const crmDigitos = normalizarCandidatoIdentidad(
        (contexto.documentoCrm !== undefined && contexto.documentoCrm !== null && contexto.documentoCrm !== '')
            ? contexto.documentoCrm
            : getGlobalDoc()
    );
    if (crmDigitos.length < 6 || crmDigitos.length > 11) return resultado;

    const texto = (typeof contexto.textoDocumento === 'string') ? contexto.textoDocumento : '';
    if (texto.trim() === '') return resultado;

    const candidato = extraerCandidatoIdentidad(texto);
    if (!candidato) {
        console.warn('[ZET][Agente] Verificación local: no se localizó identificación en el texto; se usa la decisión del agente.');
        return resultado;
    }
    if (candidato !== crmDigitos) {
        console.error('[ZET][Agente] VERIFICACIÓN LOCAL: candidato del texto (' + candidato +
            ') != documento del CRM (' + crmDigitos + '). Se rechaza aunque el agente diga válido.');
        return Object.assign({}, resultado, {
            status: 'invalid',
            message: 'El número de documento del adjunto (' + candidato +
                ') no coincide con el registrado en la oportunidad (' + crmDigitos + '). Verifique el archivo.'
        });
    }
    return resultado;
};

/**
 * Evalúa la respuesta del agente de Zia Agents.
 *
 * Precedencia (comentarios de la lógica):
 *  0. JSON estructurado del agente ({estado_definitivo, ...}) -> fuente
 *     PRINCIPAL de la decisión. Las reglas y la "justificacion" que se muestra
 *     al usuario están documentadas en evaluarRespuestaJson(). Si el JSON no
 *     existe o viene mal formado, se continúa con los pasos 1-4 de abajo.
 *  1. Flag estructurado explícito de rechazo -> INVÁLIDO (no se sobreescribe).
 *  2. Palabras clave de INVÁLIDO en el texto -> INVÁLIDO (se revisa antes que
 *     las de VÁLIDO para cubrir negaciones: "no coincide", "no es válido", ...).
 *  3. Flag estructurado de aceptación o palabras clave de VÁLIDO -> VÁLIDO.
 *     (Un {success:true} genérico de "la llamada HTTP salió bien" NO basta si el
 *     texto manifiesta lo contrario: el paso 2 tiene prioridad.)
 *  4. Nada interpretable -> 'unknown': NO se asume válido y el botón queda
 *     bloqueado.
 *
 * @param {object|string} rawResponse  respuesta cruda de zrc.triggerValidationAgent
 * @param {{textoDocumento?:string, documentoCrm?:string}} contexto
 *        textoDocumento: texto extraído que se envió al agente (verificación
 *        determinista local). Si se omite, solo se usa la respuesta del agente.
 * @returns {{status: 'valid'|'invalid'|'unknown', message: string,
 *            estado?: string, tipoDocumento?: string|null, coincidencia?: *,
 *            justificacion?: string}}
 */
export const evaluateAgentResponse = (rawResponse, contexto = {}) => {
    const resultado = evaluarRespuestaAgente(rawResponse, contexto);
    return aplicarVerificacionLocal(resultado, contexto);
};

/** Lógica interna de evaluación (sin la verificación local final). */
const evaluarRespuestaAgente = (rawResponse, contexto = {}) => {
    // 0) JSON estructurado del agente (fuente principal de la decisión)
    const json = parsearJsonAgente(rawResponse);
    if (json) {
        // Campos clave del JSON registrados en consola para depuración
        console.log('[ZET][Agente] JSON detectado. estado_definitivo:', json.estado_definitivo,
            '| tipo_documento:', json.tipo_documento,
            '| coincidencia_identidad:', json.coincidencia_identidad,
            '| documento_estudiante:', json.documento_estudiante);
        const porJson = evaluarRespuestaJson(json, contexto);
        if (porJson) {
            console.log('[ZET][Agente] Decisión por JSON ->', porJson.status,
                porJson.message ? '| mensaje: ' + porJson.message : '| sin mensaje');
            return porJson;
        }
        // JSON presente pero SIN "estado_definitivo": se usa el respaldo
        console.warn('[ZET][Agente] JSON sin "estado_definitivo"; se aplica el flujo de respaldo (flags + palabras clave).');
    }

    const texto = extraerTextoRespuestaAgente(rawResponse);
    const textoNormalizado = normalizarTexto(texto);
    const flag = detectarFlagEstructurado(rawResponse);

    // 1) Rechazo estructurado
    if (flag === 'invalid') {
        console.error('[ZET][Agente] Respuesta con flag de rechazo. Texto:', texto);
        return {
            status: 'invalid',
            message: 'El agente de validación indicó que el documento adjunto NO es válido para el número de documento del estudiante.' +
                (texto ? ' Respuesta del agente: "' + recortarTexto(texto, 300) + '"' : '')
        };
    }

    // 2) Rechazo por palabras clave INVÁLIDO o por negación detectada
    const coincideInvalido = textoNormalizado !== '' && PALABRAS_CLAVE_INVALIDO.some(p => textoNormalizado.includes(normalizarTexto(p)));
    const hayNegacion = textoNormalizado !== '' && PATRON_NEGACION.test(textoNormalizado);
    if (coincideInvalido || hayNegacion) {
        console.error('[ZET][Agente] Respuesta interpretada como INVÁLIDA:', texto);
        return {
            status: 'invalid',
            message: 'El agente de validación indicó que el documento adjunto NO es válido (no coincide con el número de documento del estudiante).' +
                (texto ? ' Respuesta del agente: "' + recortarTexto(texto, 300) + '"' : '')
        };
    }

    // 3) Aceptación
    if (flag === 'valid') {
        console.log('[ZET][Agente] Validación VÁLIDA (flag estructurado). Texto:', texto);
        return { status: 'valid', message: '' };
    }
    const coincideValido = textoNormalizado !== '' && PALABRAS_CLAVE_VALIDO.some(p => textoNormalizado.includes(normalizarTexto(p)));
    if (coincideValido) {
        console.log('[ZET][Agente] Validación VÁLIDA (texto). Texto:', texto);
        return { status: 'valid', message: '' };
    }

    // 4) Indeterminado: NO se asume que el documento sea válido
    console.warn('[ZET][Agente] No se pudo interpretar la respuesta del agente:', texto || '(sin texto)');
    return {
        status: 'unknown',
        message: 'No se pudo determinar la validez del documento. Vuelva a seleccionar el archivo para reintentar.' +
            (texto ? ' Respuesta del agente: "' + recortarTexto(texto, 300) + '"' : '')
    };
};

