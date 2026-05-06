import { setContactInfo, getContactInfo, createFolder, getDealsCoql,updateDeal,setGlobalFolderId,getGlobalFolderId,uploadFile,setGlobalTipoPrograma, getGlobalTipoPrograma, fileToGCP, getGlobalDoc, setGlobalDoc, fileToAWS, setGlobalPrograma, getGlobalPrograma } from "./global.js";

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
                    
                    updateDeal(dealId, folderIdCreated).then(function(updateResponse) {
                    //console.log("Oportunidad actualizada:", updateResponse);
                });
                });
            }
        }
    });


    const sendButton = document.getElementById("sendButton");

    // Show/hide file fields based on program type
    function showFieldsForProgram(programType) {
        const p = (programType || '').toString().toLowerCase();
        const mapping = {
            'pregrado': ['inputGroupFile1','inputGroupFile2','inputGroupFile3','inputGroupFile4'],
            'tecnico': ['inputGroupFile1','inputGroupFile2','inputGroupFile3'],
            'postgrado': ['inputGroupFile2','inputGroupFile5','inputGroupFile6','inputGroupFile7']
        };
        const toShow = mapping[p] || ['inputGroupFile2'];
        // hide all
        document.querySelectorAll('.file-field').forEach(el => el.style.display = 'none');
        // show selected
        toShow.forEach(id => {
            const el = document.getElementById(id);
            if (el && el.parentElement) el.parentElement.style.display = '';
        });
        // Refresh button state
        updateSendButton();
    }

    // Unified updateSendButton: check only visible file inputs
    function updateSendButton() {
        const msgEl = document.getElementById("mensaje-error");
        if (!sendButton) return;
        const visibleInputs = Array.from(document.querySelectorAll('.file-field input[type="file"]'))
            .filter(i => i.parentElement && window.getComputedStyle(i.parentElement).display !== 'none');
        if (visibleInputs.length === 0) {
            sendButton.disabled = true;
            return;
        }
        const allHave = visibleInputs.every(i => i.files && i.files.length > 0);
        if (allHave) {
            if (msgEl) msgEl.innerText = "";
            sendButton.disabled = false;
        } else {
            if (msgEl) msgEl.innerText = "Por favor, cargue todos los archivos requeridos para " + getGlobalTipoPrograma();
            sendButton.disabled = true;
        }
    }

    // ACTUALIZACION DINAMICA BOTON DE ENVIAR
    document.querySelectorAll('.file-field input[type="file"]').forEach(inp => inp.addEventListener('change', updateSendButton));
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
        const visibleInputs = Array.from(document.querySelectorAll('.file-field input[type="file"]'))
            .filter(i => i.parentElement && window.getComputedStyle(i.parentElement).display !== 'none');
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
                ///ENVIAR ARCHIVO A GCP
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
