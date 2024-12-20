/**
 * Copyright (c) 2024, WSO2 LLC. (https://www.wso2.com).
 *
 * This software is the property of WSO2 LLC. and its suppliers, if any.
 * Dissemination of any information or reproduction of any material contained
 * herein in any form is strictly forbidden, unless permitted by WSO2 expressly.
 * You may not alter or remove any copyright or other notice from copies of this content.
 */

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware to parse JSON body.
app.use(bodyParser.json());

// Get the webhook secret and GitHub token from environment variables
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;  // GitHub token to update the issue body
const PROJECT_NODE_ID = process.env.PROJECT_NODE_ID; // Predefined project_node_id
const CHECKLIST_FILE = 'checklist.md'; // Path to your checklist file
const X_HUB_SIGNATURE_256 = 'x-hub-signature-256'; // Header for the GitHub signature
const SHA256_HEADER_PREFIX = 'sha256='; // Prefix for the SHA-256 signature

// Function to verify the signature
function verifySignature(req) {
    const signature = req.headers[X_HUB_SIGNATURE_256];
    const hmac = crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET);
    const digest = `${SHA256_HEADER_PREFIX}${hmac.update(JSON.stringify(req.body)).digest('hex')}`;
    return signature === digest;
}

// Function to get issue URL and body from content_node_id using GraphQL
async function getIssueDetails(contentNodeId) {
    const query = `
        query($id: ID!) {
            node(id: $id) {
                ... on Issue {
                    url
                    body
                }
            }
        }
    `;

    try {
        const response = await axios.post(
            'https://api.github.com/graphql',
            {
                query: query,
                variables: { id: contentNodeId },
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GITHUB_TOKEN}`,
                },
            }
        );

        const data = response.data;
        if (data.errors) {
            console.error('Error fetching issue details:', data.errors);
            return null;
        }

        return data.data.node ? { url: data.data.node.url, body: data.data.node.body } : null;
    } catch (error) {
        console.error('Error during GraphQL request:', error);
        return null;
    }
}

// Function to read the checklist file
function readChecklist() {
    try {
        const content = fs.readFileSync(CHECKLIST_FILE, 'utf-8');
        const lines = content.split('\n');
        return {
            firstLine: lines[0], // The first line of the file
            fullContent: content, // The entire content of the file
        };
    } catch (error) {
        console.error('Error reading checklist file:', error);
        return null;
    }
}

// Function to update the issue body by appending text
async function updateIssueBody(issueUrl) {
    // Extract the issue number and repository from the issue URL
    const issueUrlParts = issueUrl.split('/');
    const owner = issueUrlParts[3];  // owner part of the URL
    const repo = issueUrlParts[4];   // repository part of the URL
    const issueNumber = issueUrlParts[6];  // issue number part of the URL

    try {
        const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
        console.log('Updating issue at:', url);

        // Fetch the existing issue data
        const issueResponse = await axios.get(url, {
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        const existingBody = issueResponse.data.body || '';

        // Append new checklist content only if the first line does not exist
        const checklist = readChecklist();
        if (checklist && !existingBody.includes(checklist.firstLine)) {
            const updatedBody = 
`${existingBody}

${checklist.fullContent}`;

            // Update the issue with the new body
            await axios.patch(url, {
                body: updatedBody
            }, {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });

            console.log('Issue updated successfully with checklist!');
        } else {
            console.log('Checklist already exists in the issue body, not updating.');
        }
    } catch (error) {
        console.error('Error updating the issue:', error.response ? error.response.data : error.message);
    }
}

app.get('/', (req, res) => {
    console.log('GET /');
    res.send('GitHub Webhook Receiver');
});

// GitHub webhook receiver endpoint
app.post('/webhook', async (req, res) => {
    // Verify the GitHub signature
    if (!verifySignature(req)) {
        console.log('Signature mismatch!');
        return res.status(403).send('Signature mismatch!');
    }

    // Check if project_node_id matches the predefined one
    const projectNodeId = req.body.projects_v2_item?.project_node_id;
    if (projectNodeId !== PROJECT_NODE_ID) {
        console.log('project_node_id does not match. No action taken.', projectNodeId, PROJECT_NODE_ID);
        return res.status(200).send('No action taken.');
    }

    // Extract content_node_id from the webhook payload
    const contentNodeId = req.body.projects_v2_item?.content_node_id;
    const action = req.body.action; // Get the action from the payload

    // Check if the action is 'created'
    if (action !== 'created') {
        console.log(`No action taken because the action is not 'created': ${action}`);
        return res.status(200).send('No action taken for non-created action.');
    }

    if (contentNodeId) {
        console.log(`Found content_node_id: ${contentNodeId}`);

        // Fetch the issue URL and body using the content_node_id
        const issueDetails = await getIssueDetails(contentNodeId);

        if (issueDetails && issueDetails.url) {
            console.log(`Issue URL: ${issueDetails.url}`);

            // Update the issue body with the checklist content
            await updateIssueBody(issueDetails.url, issueDetails.body);
        } else {
            console.log('Could not fetch issue details');
        }
    } else {
        console.log('content_node_id not found in the webhook payload');
    }

    // Respond with success
    res.status(200).send('Webhook received and processed!');
});

// Start the server
app.listen(PORT, () => {
    console.log(`GitHub Webhook Receiver running on port ${PORT}`);
});
