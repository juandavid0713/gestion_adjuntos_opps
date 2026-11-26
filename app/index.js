import { setContactInfo, getContactInfo, createFolder, getDealsCoql,updateDeal,setGlobalFolderId,getGlobalFolderId,uploadFile,setGlobalTipoPrograma, getGlobalTipoPrograma, getGlobalDoc, setGlobalDoc, fileToAWS, setGlobalPrograma, getGlobalPrograma, extraerTextoDocumento, triggerValidationAgent, evaluateAgentResponse, validarDatosPrueba, tipoPruebaPorPrograma, tipoPruebaPorCodigo, extraerNumeroRegistro } from "./global.js";

ZOHO.embeddedApp.on("PageLoad", function (data) {
   
   
    setContactInfo(data.Entity, data.EntityId);
    let dealId = getContactInfo().entityId;

    const coqlQuery = { "select_query": "select Deal_Name, Stage, Created_Time, Programa.Product_Name, Programa.Periodo, Programa.Tipo, Owner.id, Owner.first_name, Owner.last_name, Workdrive_Folder_ID, Contact_Name.N_mero_de_identificaci_n1 from Deals where (id = " + dealId + ")" };

    getDealsCoql(coqlQuery).then(function(dealsData) {
        let dealsDataJson = JSON.stringify(dealsData.data);
        //console.log("Oportunidades encontradas:", dealsDataJson);
        if(dealsDataJson != null && dealsDataJson != "" && dealsDataJson != "null"){
            let DataJson = JSON.parse(dealsDataJson).data; 
            let folderId = DataJson[0].Workdrive_Folder_ID;
            let deal_name = DataJson[0].Deal_Name;
            let tipoPrograma = DataJson[0]["Programa.Tipo"];
            let nombrePrograma = DataJson[0]["Programa.Product_Name"];
            let doc = DataJson[0]["Contact_Name.N_mero_de_identificaci_n1"];
            //console.log("Tipo de programa:", tipoPrograma);
            setGlobalTipoPrograma(tipoPrograma);
            setGlobalDoc(doc);
            setGlobalPrograma(nombrePrograma);
            // Mostrar campos según tipo de programa
            try { showFieldsForProgram(tipoPrograma); } catch(e) { console.warn('showFieldsForProgram no disponible aún', e); }
            //console.log("Tipo de programa:", tipoPrograma);
            if(folderId != null && folderId != "" && folderId != "null"){
                //console.log("La oportunidad ya tiene una carpeta asociada con ID:", folderId);
                setGlobalFolderId(folderId);
            }
            else{
                createFolder(deal_name).then(function(response) {
                    let folder_data = JSON.stringify(response);
                    let DataJsonFolder = JSON.parse(folder_data).data.data;
                    let folderIdCreated = DataJsonFolder.id;
                    setGlobalFolderId(folderIdCreated);
                    
                    // updateDeal acepta también la forma clásica updateDeal(dealId, folderId)
                    updateDeal(dealId, { folderId: folderIdCreated }).then(function(updateResponse) {
                    //console.log("Oportunidad actualizada:", updateResponse);
                }).catch(function(errUpdate) {
                    // No se rompe el flujo: la carpeta ya quedó creada
                    console.error('[ZET] Error guardando la carpeta en la oportunidad:', errUpdate);
                });
                });
            }
        }
    }).catch(function(errCarga) {
        // Sin los datos de la oportunidad no se sabe qué campos mostrar ni el
        // tipo de programa: se informa y se deja el botón bloqueado.
        console.error('[ZET] No se pudo cargar la oportunidad (COQL):', errCarga);
        const msg = document.getElementById('mensaje-error');
        if (msg) msg.innerText = 'No se pudo cargar la información de la oportunidad. Cierre el widget e inténtelo de nuevo.';
        updateSendButton();
    });


    const sendButton = document.getElementById("sendButton");

    /**
     * Única forma de habilitar/deshabilitar el botón de envío. Sincroniza el
     * atributo `disabled` con la clase CSS `disabled` de Bootstrap para que el
     * botón realmente se vea grisado (btn-primary no atenúa el color por el
     * simple hecho de tener el atributo disabled).
     */
    function setSendButtonDisabled(deshabilitado) {
        if (!sendButton) return;
        sendButton.disabled = !!deshabilitado;
        sendButton.classList.toggle('disabled', !!deshabilitado);
        // aria-disabled coherente para lectores de pantalla
        if (deshabilitado) sendButton.setAttribute('aria-disabled', 'true');
        else sendButton.removeAttribute('aria-disabled');
    }

    /* =====================================================================
       CAMPOS OBLIGATORIOS (según tipo de programa) + VALIDACIÓN CON EL AGENTE ZIA
       ---------------------------------------------------------------------
       FLUJO DE VALIDACIÓN (app/global.js):
       1. extraerTextoDocumento(file): extrae el TEXTO del adjunto
          (pdf-parse para PDF digital; tesseract.js para PDF escaneado).
          Los campos de Pruebas saber11/saberpro solo aceptan PDF: las
          imágenes se descartan al seleccionarlas..
       2. triggerValidationAgent(texto): envía el texto dentro de "query"
          (body SIN "attachments" y sin subida a ZFS) junto con el contexto
          del formulario (programa, tipo de prueba, registro y fecha) y
          muestra el loader "Validando documento con el agente...".
       3. evaluateAgentResponse(): interpreta la respuesta del agente.
          PRIORIDAD: el JSON estructurado { estado_definitivo,
          documento_estudiante, tipo_documento, coincidencia_identidad,
          justificacion } (ver REGLAS DE DECISIÓN en app/global.js). Cuando la
          validación NO permite enviar ('invalid' / 'unknown'), el mensaje que
          se pinta en #mensaje-error-validacion-documento es la "justificacion"
          del agente (o un texto genérico de respaldo si no viene). Si el JSON
          no llega o está mal formado, se usa el respaldo de siempre (flags +
          palabras clave).
       4. validarDatosPrueba() (PASO 1b de global.js): reglas deterministas
          del instructivo ICFES sobre el número de registro y la fecha de
          aplicación. Se combinan con el resultado del agente: si las reglas
          locales fallan, el envío se bloquea aunque el agente diga "válido".
          Al corregir registro/fecha se recalculan SIN repetir la llamada al
          agente (textoAdjuntoValidado + identidadValidada).
          Incluye la correspondencia PROGRAMA ↔ PRUEBA: pregrado/técnico
          exigen Saber 11 (AC…/VG…/CONVENIO) y postgrado exige Saber Pro
          (EK…/gradopostumo). Un EK en pregrado (o un AC en postgrado) bloquea
          aunque el código coincida con el del adjunto y con el documento.
       REVELADO PROGRESIVO (pregrado/postgrado):
       0. Al cargar la oportunidad solo se muestran Número de registro y Fecha
          de aplicación. Los campos de archivo aparecen cuando ambos están
          diligenciados; en técnico se mantiene el flujo anterior.
       SUPUESTOS:
       - agentValidation.status puede ser:
           'none'    -> no aplica (el programa no usa saber11/saberpro, o el
                        campo visible no tiene archivo): NO bloquea.
           'pending' -> se está validando: bloquea y muestra "Validando...".
           'valid'   -> el agente confirmó el adjunto: NO bloquea.
           'invalid' -> el agente indicó que NO coincide / no es válido: bloquea.
           'unknown' -> respuesta ambigua o error de red/extracción: se trata
                        como NO validado y bloquea (nunca se asume válido).
       ===================================================================== */
    let agentValidation = { status: 'none', message: '' };
    // Token para descartar respuestas tardías de validaciones anteriores
    let agentValidationToken = 0;
    // Texto del último PDF validado y resultado de IDENTIDAD del agente. Se
    // guardan por separado de `agentValidation` para poder revalidar las reglas
    // deterministas (registro/fecha) cuando el usuario corrige un campo, sin
    // volver a llamar al agente.
    let textoAdjuntoValidado = '';
    let identidadValidada = null;
    // Mensaje cuando el usuario intenta cargar un archivo que no es PDF en los
    // campos de pruebas Saber. Se mantiene hasta que seleccione un PDF válido.
    let mensajeArchivoInvalido = '';
    // Campos obligatorios (NO llevan clase .file-field): su visibilidad la
    // decide showFieldsForProgram según el tipo de programa.
    const CAMPOS_OBLIGATORIOS = ['numeroRegistro', 'fechaAplicacionPrueba'];
    // Programas que diligencian número de registro y fecha antes de cargar
    // archivos. En técnico se mantiene el comportamiento anterior.
    const programaUsaDatosPrueba = (programType) => {
        const p = (programType || '').toString().trim().toLowerCase();
        return p === 'pregrado' || p === 'postgrado';
    };
    const datosPruebaCompletos = () =>
        CAMPOS_OBLIGATORIOS.every(id => !!getValorCampo(id));


    /** Valor (recortado) de un campo del formulario; '' si no existe. */
    const getValorCampo = (id) => {
        const el = document.getElementById(id);
        return el ? String(el.value || '').trim() : '';
    };

    /** ¿El campo (por id) está visible en pantalla? (su contenedor .mb-3) */
    const estaVisible = (id) => {
        const el = document.getElementById(id);
        if (!el) return false;
        const cont = el.closest('.mb-3') || el.parentElement;
        return !!cont && window.getComputedStyle(cont).display !== 'none';
    };

    /**
     * Mensaje de la validación de la IA en SU PROPIO RENGLÓN
     * (#mensaje-error-validacion-documento), separado de #mensaje-error para
     * que la justificación no se concatene con los otros mensajes ni estire el
     * layout hacia la izquierda. Se oculta (display:none) cuando no hay texto.
     *
     * @param {string} texto  mensaje a mostrar ('' lo oculta)
     * @param {'error'|'proceso'|'ok'|''} tipo  color del badge
     */
    const mostrarMensajeValidacionDocumento = (texto, tipo) => {
        const el = document.getElementById('mensaje-error-validacion-documento');
        if (!el) return;
        const mensaje = (texto === null || texto === undefined) ? '' : String(texto).trim();
        // Se limpian las clases de color; "text-wrap" permite el salto de línea
        // (el .badge de Bootstrap trae white-space: nowrap por defecto).
        el.className = 'badge fs-6 text-wrap';
        el.innerText = mensaje;
        if (!mensaje) {
            el.style.display = 'none';
            return;
        }
        el.style.display = 'block';
        if (tipo === 'ok') el.classList.add('text-bg-success');
        else if (tipo === 'proceso') el.classList.add('text-bg-warning');
        else el.classList.add('text-bg-danger');
    };

    /**
     * Botón "Reintentar validación": solo se muestra cuando el agente NO pudo
     * validar (status 'unknown': error de red/OCR). Volver a elegir el mismo
     * archivo no dispara el evento 'change', así que este botón es la única
     * forma de reintentar sin cambiar de documento.
     */
    const retryBtn = document.getElementById('reintentarValidacion');
    const mostrarReintentoValidacion = (mostrar) => {
        if (!retryBtn) return;
        retryBtn.style.display = mostrar ? 'inline-block' : 'none';
    };

    /**
     * Input de adjunto que participa en la validación con el agente:
     * inputGroupFile1 ("Pruebas saber11") tiene prioridad; si no,
     * inputGroupFile7 ("Pruebas saberpro"). Solo aplica si el campo está
     * VISIBLE y tiene archivo (si no, la validación no aplica y no bloquea).
     */
    const getAdjuntoAgenteVisible = () => {
        const ids = ['inputGroupFile1', 'inputGroupFile7'];
        for (const id of ids) {
            const inp = document.getElementById(id);
            if (!inp) continue;
            const visible = inp.closest('.file-field') && window.getComputedStyle(inp.closest('.file-field')).display !== 'none';
            if (visible && inp.files && inp.files.length > 0) return inp;
        }
        return null;
    };

    /** ¿El archivo es PDF? (por MIME o extensión). Solo PDF en pruebas Saber. */
    const esPdfSeleccionado = (file) => {
        const nombre = String((file && file.name) || '').toLowerCase();
        const tipo = String((file && file.type) || '').toLowerCase();
        return tipo === 'application/pdf' || /\.pdf$/.test(nombre);
    };

    /** Tipo de prueba según el input que tiene el adjunto. */
    const tipoPruebaDelAdjunto = (inp) =>
        (inp && inp.id === 'inputGroupFile7') ? 'saberpro' : 'saber11';

    /**
     * Reglas deterministas de número de registro y fecha (PASO 1b de global.js).
     * Solo aplican a pregrado/postgrado, que son los que diligencian los campos.
     *
     * Además, SIEMPRE se exige que la prueba corresponda al programa
     * (pregrado/técnico -> Saber 11; postgrado -> Saber Pro). En técnico no hay
     * registro ni fecha diligenciados, pero un certificado del otro tipo de
     * prueba tampoco se admite.
     */
    const evaluarDatosPrueba = (inp) => {
        if (!inp) {
            return { status: 'ok', message: '', errores: [] };
        }
        const tipoPrograma = getGlobalTipoPrograma();
        if (!programaUsaDatosPrueba(tipoPrograma)) {
            const esperado = tipoPruebaPorPrograma(tipoPrograma);
            const leido = esperado ? tipoPruebaPorCodigo(extraerNumeroRegistro(textoAdjuntoValidado)) : '';
            if (esperado && leido && leido !== esperado) {
                const mensaje = 'El adjunto corresponde a ' +
                    (leido === 'saberpro' ? 'Saber Pro' : 'Saber 11') +
                    ', pero el programa es de tipo ' + (tipoPrograma || 'técnico') +
                    ' y exige ' + (esperado === 'saberpro' ? 'Saber Pro' : 'Saber 11') +
                    ': adjunte el certificado correcto.';
                return { status: 'invalid', message: mensaje, errores: [mensaje] };
            }
            return { status: 'ok', message: '', errores: [] };
        }
        return validarDatosPrueba({
            tipoPrueba: tipoPruebaDelAdjunto(inp),
            tipoPrograma: tipoPrograma,
            numeroRegistro: getValorCampo('numeroRegistro'),
            fechaAplicacion: getValorCampo('fechaAplicacionPrueba'),
            textoDocumento: textoAdjuntoValidado
        });
    };

    /**
     * Recalcula el estado del botón combinando:
     *   1) reglas locales de registro/fecha (siempre, con el texto ya extraído);
     *   2) resultado de identidad del agente (cacheado por archivo).
     * No llama al agente: sirve cuando el usuario corrige un campo.
     */
    const recombinarValidacion = () => {
        const inp = getAdjuntoAgenteVisible();
        if (!inp || !textoAdjuntoValidado || !identidadValidada) {
            updateSendButton();
            return;
        }
        const local = evaluarDatosPrueba(inp);
        agentValidation = (local.status !== 'ok')
            ? { status: local.status, message: local.message }
            : identidadValidada;
        updateSendButton();
    };

    /** Rechaza archivos que no sean PDF en los campos de pruebas Saber. */
    const validarArchivoPdf = (inp) => {
        const file = inp && inp.files && inp.files[0];
        if (!file) return false;
        if (esPdfSeleccionado(file)) {
            mensajeArchivoInvalido = '';
            return true;
        }

        // Se descarta la selección y se resetea la validación del documento.
        try { inp.value = ''; } catch (e) { /* algunos navegadores no lo permiten */ }
        textoAdjuntoValidado = '';
        identidadValidada = null;
        mensajeArchivoInvalido = 'Solo se admiten archivos PDF para Pruebas saber11 y Pruebas saberpro.';
        agentValidation = { status: 'none', message: '' };
        agentValidationToken += 1; // invalida respuestas en vuelo
        mostrarMensajeValidacionDocumento('', '');
        updateSendButton();
        return false;
    };

    /**
     * Extrae el TEXTO del adjunto visible (saber11 / saberpro), lo envía al
     * agente de Zia Agents y actualiza la bandera agentValidation.
     *
     *   PASO 1 -> extraerTextoDocumento()  (pdf-parse o OCR con tesseract.js)
     *   PASO 2 -> triggerValidationAgent() (el texto viaja en "query",
     *             sin "attachments" y sin subir el archivo a ZFS)
     *   PASO 3 -> evaluateAgentResponse() -> 'valid' | 'invalid' | 'unknown'
     *
     * Cualquier error deja status:'unknown' y bloquea el botón de enviar.
     */
    async function validarAdjuntoConAgente() {
        const inp = getAdjuntoAgenteVisible();
        agentValidationToken += 1;
        const token = agentValidationToken;

        if (!inp) {
            // Sin adjunto de saber11/saberpro: la validación no aplica
            agentValidation = { status: 'none', message: '' };
            updateSendButton();
            return;
        }

        // Solo PDF en las pruebas Saber (descarta imágenes: no se puede
        // garantizar la lectura del registro).
        if (!validarArchivoPdf(inp)) return;

        // Se resetea a 'pending' de forma SÍNCRONA (antes del primer await) y
        // se deshabilita el botón YA. Así, el listener 'change' de updateSendButton
        // que se ejecuta en el MISMO tick nunca ve un estado 'valid' obsoleto y no
        // re-habilita el botón mientras el agente vuelve a validar.
        textoAdjuntoValidado = '';
        identidadValidada = null;
        agentValidation = { status: 'pending', message: 'Validando documento con el agente, espere...' };
        setSendButtonDisabled(true);
        updateSendButton();

        try {
            // PASO 1: extraer el texto del adjunto ("Extrayendo texto del
            // documento..." / "Aplicando OCR...")
            const extraccion = await extraerTextoDocumento(inp.files[0]);
            if (token !== agentValidationToken) return; // respuesta tardía: se ignora
            textoAdjuntoValidado = extraccion.texto;
            console.log('[ZET] Texto extraído del adjunto. método:', extraccion.metodo,
                '| caracteres:', extraccion.texto.length);

            // PASO 2: el agente recibe el texto dentro de "query" + el contexto
            // del formulario (programa, registro diligenciado y fecha) para que
            // pueda aplicar las reglas del instructivo.
            const respuesta = await triggerValidationAgent(extraccion.texto, {
                doc: getGlobalDoc(),
                programa: getGlobalPrograma(),
                // X-ZIAAGENTS-AGENT-SESSION-ID = id de la oportunidad
                dealId: dealId,
                tipoPrograma: getGlobalTipoPrograma(),
                tipoPrueba: tipoPruebaDelAdjunto(inp),
                numeroRegistro: getValorCampo('numeroRegistro'),
                fechaAplicacion: getValorCampo('fechaAplicacionPrueba')
            });
            if (token !== agentValidationToken) return; // respuesta tardía: se ignora

            // PASO 3: interpretar la respuesta del agente. Si vino el JSON
            // estructurado, decide la validación y su "justificacion" queda en
            // message (es lo que verá el usuario en #mensaje-error cuando el
            // botón de enviar esté deshabilitado); si no, aplica el respaldo
            // (flags estructurados + palabras clave) en evaluateAgentResponse().
            // Se pasa el texto extraído para una verificación DETERMINISTA
            // local: el agente no puede declarar válido un documento cuyo
            // número no coincida con el del CRM.
            const evaluacion = evaluateAgentResponse(respuesta.response, {
                textoDocumento: extraccion.texto,
                documentoCrm: getGlobalDoc()
            });
            identidadValidada = { status: evaluacion.status, message: evaluacion.message || '' };
            // Campos extra del JSON del agente (opcionales, no rompen {status, message})
            if (evaluacion.estado !== undefined) identidadValidada.estado = evaluacion.estado;
            if (evaluacion.tipoDocumento !== undefined) identidadValidada.tipoDocumento = evaluacion.tipoDocumento;
            if (evaluacion.coincidencia !== undefined) identidadValidada.coincidencia = evaluacion.coincidencia;
            if (evaluacion.justificacion !== undefined) identidadValidada.justificacion = evaluacion.justificacion;

            // PASO 4: reglas deterministas de número de registro y fecha. Si
            // fallan, bloquean aunque el agente diga que la identidad coincide.
            const local = evaluarDatosPrueba(inp);
            agentValidation = (local.status !== 'ok')
                ? { status: local.status, message: local.message }
                : identidadValidada;

            console.log('[ZET] Validación finalizada:', agentValidation.status, agentValidation.message,
                '| validación local:', local.status,
                '| estado:', identidadValidada.estado, '| tipoDocumento:', identidadValidada.tipoDocumento,
                '| coincidencia:', identidadValidada.coincidencia);
        } catch (err) {
            if (token !== agentValidationToken) return;
            // Error de extracción o de red: NO se asume que sea válido -> bloquea
            console.error('[ZET] Error validando el adjunto con el agente:', err);
            identidadValidada = null;
            agentValidation = {
                status: 'unknown',
                message: 'No fue posible validar el documento con el agente. Verifique su conexión y use "Reintentar validación" o seleccione el archivo de nuevo.'
            };
        }
        updateSendButton();
    }

    // Show/hide file fields based on program type.
    // Flujo progresivo (pregrado/postgrado): primero solo se piden Número de
    // registro y Fecha de aplicación; al diligenciarlos aparecen los archivos.
    // En técnico se mantiene el comportamiento anterior (solo archivos).
    function showFieldsForProgram(programType, silencioso) {
        const p = (programType || '').toString().toLowerCase();
        const archivos = {
            'pregrado': ['inputGroupFile1','inputGroupFile2','inputGroupFile3','inputGroupFile4'],
            'tecnico': ['inputGroupFile1','inputGroupFile2','inputGroupFile3'],
            'postgrado': ['inputGroupFile2','inputGroupFile5','inputGroupFile6','inputGroupFile7']
        };
        const toShow = archivos[p] || ['inputGroupFile2'];
        // hide all (campos de archivo + campos obligatorios)
        document.querySelectorAll('.file-field').forEach(el => el.style.display = 'none');
        CAMPOS_OBLIGATORIOS.forEach(id => {
            const el = document.getElementById(id);
            if (el && el.parentElement) el.parentElement.style.display = 'none';
        });

        if (programaUsaDatosPrueba(p)) {
            // Número de registro primero, luego fecha (orden del DOM)
            CAMPOS_OBLIGATORIOS.forEach(id => {
                const el = document.getElementById(id);
                if (el && el.parentElement) el.parentElement.style.display = '';
            });
            // Los archivos solo aparecen cuando los dos campos están completos
            if (datosPruebaCompletos()) {
                toShow.forEach(id => {
                    const el = document.getElementById(id);
                    if (el && el.closest('.file-field')) el.closest('.file-field').style.display = '';
                });
            }
        } else {
            toShow.forEach(id => {
                const el = document.getElementById(id);
                if (el && el.closest('.file-field')) el.closest('.file-field').style.display = '';
            });
        }

        // Refresh button state
        if (!silencioso) updateSendButton();
    }

    /**
     * updateSendButton UNIFICADA. Solo habilita #sendButton cuando:
     *  1) todos los inputs de archivo VISIBLES tienen archivo,
     *  2) fechaAplicacionPrueba tiene valor (si el campo está visible),
     *  3) numeroRegistro tiene valor (si el campo está visible),
     *  4) si aplica la validación del agente (saber11/saberpro con archivo),
     *     agentValidation.status === 'valid'.
     * Mensajes: #mensaje-error lleva lo que falta del formulario y
     * #mensaje-error-validacion-documento lleva SOLO la respuesta de la IA
     * (justificación) en su propio renglón, sin concatenarse con los demás.
     */
    function updateSendButton() {
        const msgEl = document.getElementById("mensaje-error");
        if (!sendButton) return;

        const bloqueos = [];

        // 0) Flujo progresivo: en pregrado/postgrado los archivos ni siquiera
        // se muestran hasta diligenciar número de registro y fecha.
        const tipoProgramaActual = getGlobalTipoPrograma();
        if (programaUsaDatosPrueba(tipoProgramaActual) && !datosPruebaCompletos()) {
            setSendButtonDisabled(true);
            mostrarReintentoValidacion(false);
            mostrarMensajeValidacionDocumento('', '');
            if (msgEl) msgEl.innerText = 'Complete el número de registro y la fecha de aplicación de la prueba para cargar los archivos.';
            return;
        }

        const visibleInputs = Array.from(document.querySelectorAll('.file-field input[type="file"]'))
            .filter(i => i.closest('.file-field') && window.getComputedStyle(i.closest('.file-field')).display !== 'none');
        if (visibleInputs.length === 0) {
            setSendButtonDisabled(true);
            mostrarReintentoValidacion(false);
            if (msgEl) msgEl.innerText = "No hay campos de archivo visibles para subir.";
            mostrarMensajeValidacionDocumento('', '');
            return;
        }

        // 1) Archivos de todos los campos visibles
        if (!visibleInputs.every(i => i.files && i.files.length > 0)) {
            if (mensajeArchivoInvalido) bloqueos.push(mensajeArchivoInvalido);
            else bloqueos.push("Cargue todos los archivos requeridos para " + (getGlobalTipoPrograma() || "el programa") + ".");
        }

        // 2) Fecha de aplicación de la prueba (obligatoria si está visible)
        if (estaVisible('fechaAplicacionPrueba') && !getValorCampo('fechaAplicacionPrueba')) {
            bloqueos.push("Ingrese la fecha de aplicación de la prueba.");
        }

        // 3) Número de registro (obligatorio si está visible)
        if (estaVisible('numeroRegistro') && !getValorCampo('numeroRegistro')) {
            bloqueos.push("Ingrese el número de registro.");
        }

        // 4) Validación con el agente (solo aplica si hay adjunto saber11/saberpro)
        if (agentValidation.status === 'pending') {
            setSendButtonDisabled(true);
            mostrarReintentoValidacion(false);
            mostrarMensajeValidacionDocumento(agentValidation.message || "Validando documento con el agente, espere...", 'proceso');
            if (msgEl) msgEl.innerText = bloqueos.join(" ");
            return;
        }
        if (agentValidation.status === 'invalid' || agentValidation.status === 'unknown') {
            // Documento no válido / no reconocido: se bloquea el envío y la
            // justificación de la IA se muestra en su propio renglón.
            setSendButtonDisabled(true);
            // Solo se ofrece reintentar si el fallo fue del proceso (red/OCR);
            // con un veredicto 'invalid' hay que cargar otro documento.
            mostrarReintentoValidacion(agentValidation.status === 'unknown');
            mostrarMensajeValidacionDocumento(
                agentValidation.message || "El documento adjunto no es válido. Seleccione un documento válido para continuar.",
                'error'
            );
        } else if (agentValidation.status === 'none' && getAdjuntoAgenteVisible()) {
            // Caso borde: hay adjunto pero aún no se disparó la validación
            setSendButtonDisabled(true);
            mostrarReintentoValidacion(false);
            mostrarMensajeValidacionDocumento("Validando documento con el agente, espere...", 'proceso');
            if (msgEl) msgEl.innerText = bloqueos.join(" ");
            return;
        } else if (agentValidation.status === 'valid') {
            mostrarReintentoValidacion(false);
            mostrarMensajeValidacionDocumento("Documento validado correctamente por el agente.", 'ok');
        } else {
            mostrarReintentoValidacion(false);
            mostrarMensajeValidacionDocumento('', '');
        }

        // La única compuerta que habilita el botón: todo debe estar completo
        // Y el documento debe estar validado. Un solo punto de decisión evita
        // que otra rama (o un listener en carrera) re-habilite el botón.
        const documentoOk = agentValidation.status === 'valid'
            || (!getAdjuntoAgenteVisible() && agentValidation.status === 'none');
        if (bloqueos.length === 0 && documentoOk) {
            if (msgEl) msgEl.innerText = "";
            setSendButtonDisabled(false);
            return;
        }

        // Cualquier otro caso (falta un campo o el documento no está validado)
        setSendButtonDisabled(true);
        if (msgEl) msgEl.innerText = bloqueos.join(" ");
    }

    // ACTUALIZACION DINAMICA BOTON DE ENVIAR
    document.querySelectorAll('.file-field input[type="file"]').forEach(inp => inp.addEventListener('change', updateSendButton));
    // Campos obligatorios: al diligenciar ambos se muestran los archivos del
    // programa y se recalculan las reglas de registro/fecha (sin volver a
    // llamar al agente).
    const alCambiarDatosPrueba = () => {
        showFieldsForProgram(getGlobalTipoPrograma(), true);
        recombinarValidacion();
    };
    CAMPOS_OBLIGATORIOS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', alCambiarDatosPrueba);
        el.addEventListener('change', alCambiarDatosPrueba);
    });
    // VALIDACIÓN CON EL AGENTE: se dispara al cambiar el adjunto de
    // "Pruebas saber11" (inputGroupFile1) o "Pruebas saberpro" (inputGroupFile7),
    // solo si ese input tiene archivo y es PDF. Al cambiarlo se resetea la
    // bandera a 'pending' y se vuelve a validar.
    ['inputGroupFile1', 'inputGroupFile7'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', function () {
            if (!validarArchivoPdf(el)) return;
            validarAdjuntoConAgente();
        });
    });
    // REINTENTO: vuelve a validar el MISMO archivo (no requiere 'change')
    if (retryBtn) {
        retryBtn.addEventListener('click', function () { validarAdjuntoConAgente(); });
    }
    const cancelButton = document.getElementById("cancelButton");

    //BOTON CANCELAR
    cancelButton.addEventListener("click", function() {
        ZOHO.CRM.UI.Popup.close().then(function(data){
        })
    });
    //BOTON X CERRAR
    const closeButton = document.getElementById("closeButton");
    closeButton.addEventListener("click", function() {
        ZOHO.CRM.UI.Popup.close().then(function(data){
        })
    });
    //BOTON ENVIAR
    sendButton.addEventListener("click", async function() {
        const dealId = getContactInfo().entityId;
        // Flujo progresivo: sin número de registro y fecha no hay archivos que enviar.
        if (programaUsaDatosPrueba(getGlobalTipoPrograma()) && !datosPruebaCompletos()) {
            document.getElementById('mensaje-error').innerText = 'Complete el número de registro y la fecha de aplicación de la prueba.';
            return;
        }
        const visibleInputs = Array.from(document.querySelectorAll('.file-field input[type="file"]'))
            .filter(i => i.closest('.file-field') && window.getComputedStyle(i.closest('.file-field')).display !== 'none');
        if (visibleInputs.length === 0) {
            document.getElementById('mensaje-error').innerText = 'No hay campos de archivo visibles para subir.';
            return;
        }
        // VALIDACION DE ARCHIVOS EN TODOS LOS CAMPOS PARA ACTIVAR BOTÓN
        for (const inp of visibleInputs) {
            if (!inp.files || inp.files.length === 0) {
                document.getElementById('mensaje-error').innerText = 'Seleccione todos los archivos visibles antes de enviar.';
                return;
            }
        }

        // CAMPOS OBLIGATORIOS (se leen en el momento del envío; obligatorios
        // cuando el campo está visible para el tipo de programa)
        const fechaAplicacionPrueba = getValorCampo('fechaAplicacionPrueba');
        const numeroRegistro = getValorCampo('numeroRegistro');
        if (estaVisible('fechaAplicacionPrueba') && !fechaAplicacionPrueba) {
            document.getElementById('mensaje-error').innerText = 'Ingrese la fecha de aplicación de la prueba.';
            return;
        }
        if (estaVisible('numeroRegistro') && !numeroRegistro) {
            document.getElementById('mensaje-error').innerText = 'Ingrese el número de registro.';
            return;
        }

        // VALIDACIÓN CON EL AGENTE: pendiente, inválida o sin confirmar => no se envía
        // (el mensaje de la IA va en su propio renglón)
        if (agentValidation.status === 'pending') {
            mostrarMensajeValidacionDocumento(agentValidation.message || 'Validando documento con el agente, espere...', 'proceso');
            return;
        }
        if (agentValidation.status === 'invalid' || agentValidation.status === 'unknown') {
            mostrarMensajeValidacionDocumento(agentValidation.message || 'El documento adjunto no es válido. Seleccione un documento válido para continuar.', 'error');
            return;
        }
        if (getAdjuntoAgenteVisible() && agentValidation.status !== 'valid') {
            mostrarMensajeValidacionDocumento('Validando documento con el agente, espere...', 'proceso');
            return;
        }

        const parentId = getGlobalFolderId();
        // NORMALIZACION DE NOMBRES
        const baseNames = {
            inputGroupFile1: 'icfes_saber11',
            inputGroupFile2: 'cedula',
            inputGroupFile3: 'acta_grado_bachiller',
            inputGroupFile4: 'diploma_bachiller',
            inputGroupFile5: 'acta_grado_pro',
            inputGroupFile6: 'diploma_grado_pro',
            inputGroupFile7: 'saber_pro'
        };

        try {
            // ACTUALIZAR LA OPORTUNIDAD CON LOS NUEVOS CAMPOS (fecha de
            // aplicación de la prueba y número de registro) junto con el envío.
            // Si falla NO se continúa, para no perder esos datos obligatorios.
            try {
                await updateDeal(dealId, {
                    folderId: parentId,
                    fechaAplicacionPrueba: fechaAplicacionPrueba,
                    numeroRegistro: numeroRegistro
                });
            } catch (updateErr) {
                console.error('[ZET] Error actualizando la oportunidad en el envío:', updateErr);
                document.getElementById('mensaje-error').innerText = 'No se pudieron guardar la fecha de aplicación y el número de registro. Verifique los datos e intente de nuevo.';
                return;
            }

            ZDK.Client.showLoader({ type: 'page', template: 'vertical-bar', message: 'Subiendo archivos...' });
            const results = [];
            for (let idx = 0; idx < visibleInputs.length; idx++) {
                const inp = visibleInputs[idx];
                const f = inp.files[0];
                const buffer = await f.arrayBuffer();
                const blob = new Blob([buffer], { type: f.type || 'application/octet-stream' });
                const ext = (function() {
                    const name = f.name || '';
                    const m = name.match(/\.([0-9a-zA-Z]+)$/);
                    if (m && m[1]) return m[1].toLowerCase();
                    if (f.type) return f.type.split('/').pop();
                    return '';
                })();
                const base = baseNames[inp.id] || `file${idx+1}`;
                const normalizedName = ext ? `${base}.${ext}` : base;
                const fileToSend = new File([blob], normalizedName, { type: f.type || 'application/octet-stream' });
                //console.log('Subiendo:', fileToSend.name);
                try {
                    ///ENVIAR ARCHIVO A WORKDRIVE
                    const uploadRes = await uploadFile(fileToSend, parentId);
                    results.push(uploadRes);
                    ///ASOCIAR ARCHIVO A LA OPORTUNIDAD EN CRM
                    try {
                        let data = uploadRes.data.data[0].attributes;
                        let permalink = data.Permalink;
                        let title = data.FileName;
                        //console.log('Intentando asociar en CRM:', title, permalink);
                        var func_name = "link_from_workdrive";
                        var req_data = {
                            "arguments": JSON.stringify({
                                "permalink": permalink,
                                "title": title,
                                "dealId": dealId
                            })
                        };
                        ZOHO.CRM.FUNCTIONS.execute(func_name, req_data).then(function(data){ console.log(data) });
                    } catch (linkErr) {
                        console.warn('Fallo asociación CRM para', fileToSend.name, linkErr);
                    }
                } catch (upErr) {
                    console.error('Error subiendo archivo', fileToSend.name, upErr);
                }
                ///ENVIAR ARCHIVO A AWS
                try {
                    const doc = getGlobalDoc();
                    const programName = getGlobalPrograma();
                    const awsRes = await fileToAWS(fileToSend, base, doc, programName);
                    //console.log('nombre archivo:', base);
                    //const gcpRes = await fileToGCP(fileToSend, normalizedName, doc);
                    //console.log('Archivo subido a GCP:', gcpRes);
                } catch (error) {
                    console.error('Error subiendo a AWS:', error);
                }
            }
            ZDK.Client.hideLoader();
            //console.log('Todas las subidas procesadas:', results);
            document.getElementById('mensaje-ok').innerText = 'Subida completada.';
            ZOHO.CRM.BLUEPRINT.proceed();
        } catch (err) {
            console.error('Error en proceso de subida:', err);
            document.getElementById('mensaje-error').innerText = 'Error al subir archivos.';
            ZDK.Client.hideLoader();
        }
        
        ZOHO.CRM.UI.Popup.closeReload().then(function(data){ 
            console.log(data);
        });
    });
});

ZOHO.embeddedApp.init();
