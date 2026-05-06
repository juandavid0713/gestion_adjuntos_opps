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

export const updateDeal = async (dealId, folderId) => {
    ZDK.Client.showLoader({
                type: 'page',
                template: 'vertical-bar',
                message: 'Actualizando oportunidad...'
        });
    const response = await zrc.put(`/crm/v8/Deals/${dealId}`, {
        data: [{
		    Workdrive_Folder_ID: folderId
	    }]
    });
    ZDK.Client.hideLoader();
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
