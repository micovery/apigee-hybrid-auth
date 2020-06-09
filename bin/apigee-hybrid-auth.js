#!/usr/bin/env node

// Copyright 2020 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const spinners = require('cli-spinners');
const ora = require('ora');
const spinner = ora(spinners.dots);
const yargs = require('yargs');


/**
 * Args processing
 */
var argv = yargs
    .option('username', {
        alias: 'u',
        describe: 'Google account username',
        required: true
    })
    .option('password', {
        alias: 'p',
        describe: 'Google account password',
        required: true
    })
    .option('browser', {
        alias: 'b',
        describe: 'whether or not show browser',
        type: 'boolean',
        required: false,
        default: false
    })
    .option('debug', {
        alias: 'd',
        describe: 'whether or not to enable debug output',
        type: 'boolean',
        required: false
    })
    .option('format', {
        alias: 'f',
        describe: 'output format (curl,json)',
        type: 'string',
        required: false,
        default: 'curl'
    })
    .version("1.0")
    .usage('Usage:\n  apigee-hybrid-auth.js -u username@google.com -p SuperSecret')
    .argv;


/**
 *  Main logic
 */
(async function main() {
    spinner.start();

    const browser = await puppeteer.launch({
        defaultViewport: null,
        headless: !argv.browser,
        ignoreHTTPSErrors: true,
        args: [
            '--window-size=1920,1080',
        ],
    });

    const context = await browser.createIncognitoBrowserContext();
    const page = await browser.newPage();

    //emulate non-headless chrome
    const headlessUserAgent = await page.evaluate(() => navigator.userAgent);
    const chromeUserAgent = headlessUserAgent.replace('HeadlessChrome', 'Chrome');
    await page.setUserAgent(chromeUserAgent);
    await page.setExtraHTTPHeaders({'accept-language': 'en-US,en;q=0.8'});

    try {
        try {
            await page.goto('https://apigee.google.com/');
        } catch(ex) {
            throw new ScriptError(`Could not load Apigee page. ${ex.message}`);
        }

        //Fill in username
        let emailFieldSelector = 'input[type="email"]';
        await waitForField(page, emailFieldSelector, 5000, 'Could not find username text field to fill out.');
        debug_log('Filling in username ...');
        await page.focus(emailFieldSelector);
        await page.keyboard.type(argv.username);

        debug_log('Clicking Next  ...');
        await clickButtonWithText(page, ['Next']);


        //wait for password field to show up
        let passwordFieldSelector = 'input[type=password]';
        try {
            await waitForField(page, passwordFieldSelector, 5000, 'Could not find password text field to fill out.');
        } catch(ex) {
            //check if account was deleted
            if (await pageHasText(page, ["Account deleted"])) {
                throw new ScriptError(`The account ${argv.username} was deleted.`);
            }

            //Check if the username does not exist
            if (await pageHasText(page, ["Couldn't find","Couldn't sign"])) {
                throw new ScriptError(`Could not sign in, check that account is valid`);
            }

            throw ex;
        }

        //Fill in password
        debug_log('Filling in password ...');
        await page.focus(passwordFieldSelector);
        await page.keyboard.type(argv.password);

        //Click Next button
        debug_log('Clicking Next  ...');
        await clickButtonWithText(page, ['Next']);

        //Accept terms if needed
        debug_log('Accepting terms if needed ...');
        await clickButtonWithText(page, 'Accept', true);

        try {
            await waitForField(page, 'csrf', 5000, 'Apigee page did not load');
        } catch(ex) {
            if (await pageHasText(page, ["Confirm"])) {
                //nothing to do, we can skip the confirmation box
            }
            else if (await pageHasText(page, ["Couldn't sign", "Sign in", "Wrong password"])) {
                throw new ScriptError(`Could not sign in, check that password is valid.`);
            } else {
                throw ex;
            }
        }

        //reload main page after accepting terms
        try {
            await page.goto('https://apigee.google.com/');
        } catch(ex) {
            throw new ScriptError(`Could not load Apigee page. ${ex.message}`);
        }

        //wait for the CSRF token
        debug_log('Waiting for Apigee main page to load ...');
        await waitForField(page, 'csrf', 10000, 'Apigee application did not load');


        let userOrg = await getUserOrg(page);
        if (!userOrg) {
            throw new ScriptError('Could not determine default user org.');
        }

        let outputFile = await saveAuthHeaders(page);

        spinner.succeed(`Authentication succeeded, org is "${userOrg}", headers saved to "${outputFile}"`);

    } finally {
        if (argv.d) {
            //capture debug information on exit
            let html = await page.evaluate(() => document.body.innerHTML);
            await fs.writeFile('./debug.html', html);
            await page.screenshot({path: 'debug.png'});
        }
        await browser.close();
    }
})()
    .then(function () {
        debug_log("Done");
        process.exit(0);

    })
    .catch(function(err) {
        spinner.fail("Authentication failed");
        console.error(`error: ${err.message}`);
        if (!(err instanceof ScriptError)) {
            console.error(err.message);
            console.error(err.stack);
        }
        process.exit(1);
    })


/**
 * Helper functions
 */

async function getUserOrg(page) {
    let orgElementId = 'user-org'
    try {
        await page.waitForFunction(`document.getElementById("${orgElementId}").innerText`, 10000);
    } catch(ex) {
        return null;
    }
    let userOrg = await page.$(`#${orgElementId}`);
    if (userOrg) {
        return page.evaluate((obj) => obj.innerText, userOrg);
    }
    return null;
}

function debug_log() {
    if (!argv.d) return;
    console.debug.apply(this, arguments);
}

async function saveAuthHeaders(page) {
    let securityHeaders = {
        'x-requested-with': 'XMLHttpRequest'
    }

    let cookies = await page.cookies();

    //build the cookie header
    let cookiePairs = [];
    for (let cookieElem of cookies) {
        cookiePairs.push(`${cookieElem.name}=${cookieElem.value}`)
    }

    securityHeaders['cookie'] = cookiePairs.join(';');

    //build the CSRF header
    let csrf = await page.$('csrf');
    if (csrf) {
        let data = await page.evaluate( (obj) => obj.getAttribute('data'), csrf);
        securityHeaders['x-apigee-csrf'] = data;
    }

    if (argv.format == 'curl') {
        let outputFile = 'auth.txt';
        let headers = [];
        for (let name in securityHeaders) {
            headers.push(`${name}: ${securityHeaders[name]}`);
        }
        await fs.writeFile(outputFile, headers.join('\n'));
        return outputFile;
    }

    let outputFile = 'auth.json';
    await fs.writeFile(outputFile, JSON.stringify(securityHeaders, null, 2));
    return outputFile;
}

async function clickButtonWithText(page, text, optional = false, delay = 2000 ) {
    if (typeof  text === 'string') {
        text = [text];
    }

    for (let buttonText of text) {
        let next = await page.$x("//input[@value='" + buttonText + "']");
        if (next.length > 0) {
            let el = next.pop();
            await el.click();
            await page.waitFor(delay);

            return true;
        }
    }

    for (let buttonText of text) {
        let next = await page.$x("//*[text()='" + buttonText + "']");
        if (next.length > 0) {
            let el = next.pop();
            await el.click();
            await page.waitFor(delay);
            return true;
        }
    }

    for (let buttonText of text) {
        let next = await page.$x("//*[text()='" + buttonText + "']/..");
        if (next.length > 0) {
            let el = next.pop();
            await el.click();
            await page.waitFor(delay);
            return true;
        }
    }

    if (optional) {
        return false;
    }

    throw new ScriptError(`Could not find ${text} button to click on.`);

}

async function waitForField(page, selector, timeout, error) {
    try {
        await page.waitForSelector(selector, {visible: true, timeout: timeout});
    } catch(ex) {
        throw new ScriptError(error);
    }
}

async function pageHasText(page, text) {
    if (typeof text === 'string') {
        text = [text];
    }

    let html = await page.evaluate(() => document.body.innerHTML);
    html = html.toLowerCase();

    for (let searchText of text) {
        if (html.indexOf(searchText.toLowerCase()) > 0) {
            return true;
        }
    }

    return false;
}

class ScriptError extends Error {
    constructor(message) {
        super(message);
        this.name = "ScriptError";
    }
}