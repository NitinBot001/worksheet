// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const stream = require('stream');
const { promisify } = require('util');
const path = require('path');

const app = express();
const port = 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

// Serve the frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const ADOBE_CLIENT_ID = process.env.ADOBE_CLIENT_ID;
const ADOBE_CLIENT_SECRET = process.env.ADOBE_CLIENT_SECRET;

// --- Helper Functions for Adobe REST API ---

// 1. Get an Access Token
async function getAccessToken() {
    const form = new FormData();
    form.append('client_id', ADOBE_CLIENT_ID);
    form.append('client_secret', ADOBE_CLIENT_SECRET);
    form.append('grant_type', 'client_credentials');
    form.append('scope', 'openid,AdobeID,read_organizations,pdf_services');

    try {
        const response = await axios.post('https://ims-na1.adobelogin.com/ims/token/v3', form, {
            headers: form.getHeaders(),
        });
        return response.data.access_token;
    } catch (error) {
        console.error("Error getting Adobe Access Token:", error.response?.data || error.message);
        throw new Error('Failed to authenticate with Adobe.');
    }
}

// 2. Poll for Job Completion
const pipeline = promisify(stream.pipeline);
async function pollForJobCompletion(pollingUrl, accessToken) {
    let status = 'in progress';
    let jobDetails;
    const maxRetries = 20; // Poll for a maximum of 40 seconds (20 retries * 2s delay)
    let retries = 0;

    console.log('Polling for job completion...');
    while (status === 'in progress' && retries < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for 2 seconds
        try {
            const response = await axios.get(pollingUrl, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'x-api-key': ADOBE_CLIENT_ID,
                },
            });
            jobDetails = response.data;
            status = jobDetails.status;
            console.log(`Job status: ${status}`);
        } catch (error) {
            console.error('Error polling job status:', error.response?.data || error.message);
            throw new Error('Failed while polling for job status.');
        }
        retries++;
    }

    if (status !== 'succeeded' && status !== 'done') {
        console.error('Job failed or timed out:', jobDetails);
        throw new Error(`PDF generation failed with status: ${status}`);
    }

    return jobDetails;
}

// --- Main API Endpoint ---
app.post('/api/generate-pdf', async (req, res) => {
    try {
        const { html } = req.body;
        if (!html) return res.status(400).send('HTML content is required.');

        // STEP 1: Get Access Token
        const accessToken = await getAccessToken();
        console.log('Successfully obtained Access Token.');

        // STEP 2: Get an Upload URI for our asset
        const assetUploadResponse = await axios.post(
            'https://pdf-services.adobe.io/assets', { mediaType: 'text/html' }, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'x-api-key': ADOBE_CLIENT_ID,
                    'Content-Type': 'application/json',
                },
            }
        );
        const { assetID, uploadUri } = assetUploadResponse.data;
        console.log('Successfully obtained asset upload URI.');

        // STEP 3: Upload the HTML content to the provided URI
        await axios.put(uploadUri, html, {
            headers: { 'Content-Type': 'text/html' },
        });
        console.log('Successfully uploaded HTML asset.');
        
        // --- THIS IS THE MODIFIED BLOCK ---
        // STEP 4: Start the PDF conversion job with page options
        const jobPayload = {
            assetID: assetID,
            includeHeaderFooter: true,
            pageLayout: {
                pageWidth: 8.27,
                pageHeight: 11.69
            },
        };

        const startJobResponse = await axios.post(
            'https://pdf-services.adobe.io/operation/htmltopdf', 
            jobPayload, 
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'x-api-key': ADOBE_CLIENT_ID,
                    'Content-Type': 'application/json',
                },
            }
        );
        const pollingUrl = startJobResponse.headers['location'];
        console.log('Successfully started PDF conversion job.');

        // STEP 5: Poll for the job's completion
        const jobDetails = await pollForJobCompletion(pollingUrl, accessToken);

        // STEP 6: Download the resulting PDF and stream it to the client
        const pdfDownloadUrl = jobDetails.asset.downloadUri;
        const pdfResponse = await axios.get(pdfDownloadUrl, {
            responseType: 'stream',
        });
        
        console.log('Successfully downloaded PDF. Streaming to client.');
        res.setHeader('Content-Type', 'application/pdf');
        await pipeline(pdfResponse.data, res);

    } catch (error) {
        console.error('Full PDF generation flow failed:', error.message);
        res.status(500).send(error.message || 'An internal server error occurred.');
    }
});

app.listen(port, () => {
    console.log(`Backend server listening at http://localhost:${port}`);
});