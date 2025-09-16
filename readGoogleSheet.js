// readGoogleSheet.js
// Reads data from a Google Sheet using googleapis + scrapes FB profiles via Playwright

import dotenv from 'dotenv';
dotenv.config();
import { google } from 'googleapis';
import playwright from 'playwright';

(async () => {
  try {
    console.log('STEP 1: Loading environment variables...');
    const SHEET_ID = process.env.SHEET_ID;
    const API_KEY = process.env.API_KEY;
    if (!SHEET_ID || !API_KEY) {
      throw new Error('Missing SHEET_ID or API_KEY in .env');
    }

    console.log('STEP 2: Reading Google Sheet...');
    const sheets = google.sheets({ version: 'v4', auth: API_KEY });
    let rows;
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Sheet1',
      });
      rows = res.data.values;
      if (!rows || rows.length === 0) {
        throw new Error('No data found in Google Sheet.');
      }
      console.log(`Loaded ${rows.length} rows from Google Sheet.`);
    } catch (err) {
      throw new Error('Error reading Google Sheet: ' + err.message);
    }

    const headers = rows[0];
    const data = rows.slice(1).map(row => {
      const obj = {};
      headers.forEach((header, i) => {
        obj[header] = row[i] || '';
      });
      return obj;
    });
    console.log('STEP 3: Mapped rows to objects.');

    console.log('STEP 4: Launching browser...');
    let browser;
    try {
      browser = await playwright.chromium.launchPersistentContext('./fb-session', {
        headless: false,
        viewport: { width: 1280, height: 800 },
      });
      console.log('Browser launched with persistent context.');
    } catch (err) {
      throw new Error('Error launching browser: ' + err.message);
    }

    const page = await browser.newPage();

  // Take the person from the 3rd row of the Google Sheet (index 2)
  const person = data[2];

    try {
      console.log(`STEP 5: Searching Facebook for: ${person.Name || person.name}`);
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1000);

      // Login check
      if (await page.locator('input[name="email"]').isVisible()) {
        console.log('Facebook login required. Logging in...');
        const FB_EMAIL = process.env.FB_EMAIL;
        const FB_PASSWORD = process.env.FB_PASSWORD;
        if (!FB_EMAIL || !FB_PASSWORD) {
          throw new Error('Missing FB_EMAIL or FB_PASSWORD in .env');
        }
        await page.fill('input[name="email"]', FB_EMAIL);
        await page.fill('input[name="pass"]', FB_PASSWORD);
        await page.click('button[name="login"]');
        console.log('If CAPTCHA appears, please solve it. Waiting 90 seconds...');
        await page.waitForTimeout(90000);

        if (await page.locator('input[name="email"]').isVisible()) {
          throw new Error('Facebook login failed. Check credentials or CAPTCHA.');
        }
        console.log('Facebook login successful.');
      } else {
        console.log('Already logged in to Facebook.');
      }

      // Search for person
      await page.fill('input[aria-label="Search Facebook"]', person.Name || person.name);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);

      // Switch to "People" tab if available
      await page.click('a[role="tab"]:has-text("People")', { timeout: 5000 }).catch(() => {
        console.log("No 'People' tab found, staying on All tab.");
      });

      // Wait for search results to load
      await page.waitForTimeout(3000);
      const searchName = (person.Name || person.name || '').toLowerCase().trim();
      // Find all anchors containing the person's name
      const nameAnchors = await page.locator('a', { hasText: person.Name || person.name }).all();
      let candidateLinks = [];
      const expectedName = (person.Name || person.name || '').toLowerCase().trim();
      for (const [i, link] of nameAnchors.entries()) {
        const linkText = (await link.textContent() || '').toLowerCase().trim();
        const href = await link.getAttribute('href') || '';
        // Ignore if linkText contains extra words beyond the expected name
        // (e.g., 'regan townsend abcdefg' is ignored if searching for 'regan townsend')
        const linkWords = linkText.split(/\s+/);
        const expectedWords = expectedName.split(/\s+/);
        // Only accept if linkText is exactly the expected name (allow case/space variations)
        if (
          href && (
            href.includes('/profile.php') ||
            href.includes('/people/') ||
            (/^https:\/\/www\.facebook\.com\/[a-zA-Z0-9\.]+$/.test(href))
          ) &&
          linkWords.length === expectedWords.length &&
          linkWords.join(' ') === expectedWords.join(' ')
        ) {
          candidateLinks.push({ link, linkText, href });
        }
        console.log(`Anchor ${i}: text='${linkText}', href='${href}'`);
      }
      console.log(`Found ${candidateLinks.length} candidate profile links with perfect name match.`);

      // Click only the first candidate anchor (most relevant result)
      let clicked = false;
      if (candidateLinks.length > 0) {
        const { link, linkText, href } = candidateLinks[0];
        await link.scrollIntoViewIfNeeded();
        await link.hover();
        await link.click({ force: true });
        console.log('Simulated mouse click on FIRST candidate profile link (most relevant):', linkText, href);
        clicked = true;
      }

      // Fallback: always click the first anchor with a valid profile-like href if no perfect match
      if (!clicked) {
        const allAnchors = await page.$$('a');
        let foundFallback = false;
        for (const link of allAnchors) {
          const href = await link.getAttribute('href') || '';
          if (
            href && (
              href.includes('/profile.php') ||
              href.includes('/people/') ||
              (/^https:\/\/www\.facebook\.com\/[a-zA-Z0-9\.]+$/.test(href))
            )
          ) {
            await link.scrollIntoViewIfNeeded();
            await link.hover();
            await link.click({ force: true });
            console.log('Fallback: Simulated mouse click on first anchor with profile-like href:', href);
            foundFallback = true;
            break;
          }
        }
        if (!foundFallback) {
          console.warn('No profile links found to click.');
        }
      }

      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2000);

      // Initialize profileData at the start of scraping block
      let profileData = {};

      // Only scrape after navigation and page load
      // Friends quantity (precise selector: <a> with href containing /friends/ and <strong> child)
      try {
        let friendsQty = '';
        // Try main selector
        try {
          const friendsAnchor = await page.locator('a[href$="/friends/"]').first({ timeout: 500 });
          const strongEl = await friendsAnchor.locator('strong').first();
          friendsQty = await strongEl.innerText();
        } catch (e) {}
        // Fallback: try any <strong> inside <a> with /friends/ in href
        if (!friendsQty) {
          const anchors = await page.locator('a[href*="/friends/"]').all();
          for (const anchor of anchors) {
            const strongs = await anchor.locator('strong').all();
            for (const strongEl of strongs) {
              const txt = await strongEl.innerText();
              if (txt && /\d+(\.\d+)?K?/.test(txt)) {
                friendsQty = txt;
                break;
              }
            }
            if (friendsQty) break;
          }
        }
        if (friendsQty) {
          profileData.friends = friendsQty;
          console.log('Friends Qty:', friendsQty);
        } else {
          profileData.friends = '';
          console.log('[Friends]: Not found!');
        }
      } catch (e) {
        profileData.friends = '';
        console.log('[Friends]: Not found!');
      }

      // Is friends list visible? (faster)
      try {
        const friendsListVisiblePromise = page.locator('a:has-text("Friends")').first({ timeout: 200 }).isVisible();
        profileData.friendsListVisible = (await friendsListVisiblePromise) ? 'Yes' : 'No';
        console.log('Friends List Visible:', profileData.friendsListVisible);
      } catch (e) {
        profileData.friendsListVisible = 'No';
        console.log('[Friends List Visible]: Not found!');
      }

      // LinkedIn profile link (faster)
      try {
        const linkedinLinkPromise = page.locator('a[href*="linkedin.com/in/"]').first({ timeout: 200 }).getAttribute('href');
        const linkedinLink = await linkedinLinkPromise;
        profileData.linkedin = linkedinLink || '';
        if (linkedinLink) {
          console.log('LinkedIn Profile:', linkedinLink);
        } else {
          console.log('[LinkedIn Profile]: Not found!');
        }
      } catch (e) {
        profileData.linkedin = '';
        console.log('[LinkedIn Profile]: Not found!');
      }

      // Email (faster)
      try {
        const emailElPromise = page.locator('a[href^="mailto:"]').first({ timeout: 200 });
        const emailEl = await emailElPromise;
        const email = await emailEl.getAttribute('href');
        profileData.email = email ? email.replace('mailto:', '') : '';
        if (profileData.email) {
          console.log('Email:', profileData.email);
        } else {
          console.log('[Email]: Not found!');
        }
      } catch (e) {
        profileData.email = '';
        console.log('[Email]: Not found!');
      }

      // Phone (faster)
      try {
        const phoneElPromise = page.locator('a[href^="tel:"]').first({ timeout: 200 });
        const phoneEl = await phoneElPromise;
        const phone = await phoneEl.getAttribute('href');
        profileData.phone = phone && phone.startsWith('tel:+61') ? phone.replace('tel:', '') : '';
        if (profileData.phone) {
          console.log('Phone:', profileData.phone);
        } else {
          console.log('[Phone]: Not found!');
        }
      } catch (e) {
        profileData.phone = '';
        console.log('[Phone]: Not found!');
      }

      // Scrape only the bio/intro section for info
      let bioText = '';
      try {
        // Try the main bio/intro selector (works for most profiles)
        const bioEl = await page.locator('div[data-testid="profile_intro_card"]').first({ timeout: 1000 });
        bioText = await bioEl.innerText();
      } catch (e) {
        // Fallback: try alternative selectors
        try {
          const bioEl = await page.locator('div:has-text("Intro")').first({ timeout: 1000 });
          bioText = await bioEl.innerText();
        } catch (e2) {
          bioText = '';
        }
      }
      profileData.bio = bioText;
      console.log('Bio/Intro text:', bioText);

      // Extract info from bio text
      // Job/Position/Company
      let positionFound = '';
      let companyFound = '';
      let locationFound = '';
      let maritalStatusFound = '';
      if (bioText) {
        // Job/Position
        const jobMatch = bioText.match(/(Works at|Broker at|Manager at|Director at|Consultant at|Agent at|Finance at|Mortgage at|Advisor at|Analyst at) ([^\n]+)/i);
        if (jobMatch) {
          positionFound = jobMatch[1];
          companyFound = jobMatch[2];
        }
        // Location
        const locationMatch = bioText.match(/Lives in ([^\n]+)/i);
        if (locationMatch) {
          locationFound = locationMatch[1];
        }
        // Marital status
        const maritalMatch = bioText.match(/(Married|Single|In a relationship|Engaged|Divorced)/i);
        if (maritalMatch) {
          maritalStatusFound = maritalMatch[1];
        }
      }
      profileData.position = positionFound;
      profileData.company = companyFound;
      profileData.location = locationFound;
      profileData.maritalStatus = maritalStatusFound;
      console.log('Extracted from bio:', { positionFound, companyFound, locationFound, maritalStatusFound });

      // If company hyperlink can be extracted from bio/company field, follow it and scrape company info
      if (profileData.company && profileData.company.startsWith('http')) {
        try {
          await page.goto(profileData.company);
          await page.waitForLoadState('domcontentloaded');
          let companyFollowers = '';
          try {
            companyFollowers = await page.locator('span:has-text("followers")').first({ timeout: 10 }).innerText();
            if (companyFollowers) {
              console.log('Company Followers:', companyFollowers);
            } else {
              console.log('[Company Followers]: Not found!');
            }
          } catch (e) {
            console.log('[Company Followers]: Not found!');
          }
          profileData.companyFollowers = companyFollowers;

          let companyPhone = '';
          try {
            const phoneEl = await page.locator('a[href^="tel:"]').first({ timeout: 10 });
            const phone = await phoneEl.getAttribute('href');
            companyPhone = phone && phone.startsWith('tel:+61') ? phone.replace('tel:', '') : '';
            if (companyPhone) {
              console.log('Company Phone:', companyPhone);
            } else {
              console.log('[Company Phone]: Not found!');
            }
          } catch (e) {
            console.log('[Company Phone]: Not found!');
          }
          profileData.companyPhone = companyPhone;

          let companyEmail = '';
          try {
            const emailEl = await page.locator('a[href^="mailto:"]').first({ timeout: 10 });
            const email = await emailEl.getAttribute('href');
            companyEmail = email ? email.replace('mailto:', '') : '';
            if (companyEmail) {
              console.log('Company Email:', companyEmail);
            } else {
              console.log('[Company Email]: Not found!');
            }
          } catch (e) {
            console.log('[Company Email]: Not found!');
          }
          profileData.companyEmail = companyEmail;

          let companyWebsite = '';
          try {
            const websiteEl = await page.locator('a[href*=".com.au"]').first({ timeout: 10 });
            const website = await websiteEl.getAttribute('href');
            companyWebsite = website || '';
            if (companyWebsite) {
              console.log('Company Website:', companyWebsite);
            } else {
              console.log('[Company Website]: Not found!');
            }
          } catch (e) {
            console.log('[Company Website]: Not found!');
          }
          profileData.companyWebsite = companyWebsite;
        } catch (e) {
          console.log('Error following company hyperlink:', e);
        }
      }

      // Company Facebook page
      let companyFbPage = '';
      try {
        const links = await page.locator('a[href*="facebook.com/"]').all();
        for (const link of links) {
          const href = await link.getAttribute('href');
          if (href && !href.includes('profile.php') && !href.includes('people/') && !href.includes('groups/') && !href.includes('events/')) {
            companyFbPage = href;
            console.log('Company Facebook Page:', companyFbPage);
            break;
          }
        }
      } catch (e) {}
      profileData.companyFbPage = companyFbPage;

      // Marital status
      const maritalKeywords = ['married', 'single', 'relationship', 'engaged', 'divorced'];
      let maritalStatus = '';
      for (const keyword of maritalKeywords) {
        try {
          const el = await page.locator(`text=${keyword}`).first();
          if (await el.isVisible()) {
            maritalStatus = await el.innerText();
            console.log('Marital Status:', maritalStatus);
            break;
          }
        } catch (e) {}
      }
      profileData.maritalStatus = maritalStatus;

      // Followers and friends
      let followers = '';
      let friends = '';
      try {
        followers = await page.locator('span:has-text("followers")').first().innerText();
        console.log('Followers:', followers);
      } catch (e) {}
      try {
        friends = await page.locator('span:has-text("friends")').first().innerText();
        console.log('Friends:', friends);
      } catch (e) {}
      profileData.followers = followers;
      profileData.friends = friends;

      // If company FB page found, scrape it
      let companyFollowers = '';
      if (companyFbPage) {
        try {
          await page.goto(companyFbPage);
          await page.waitForLoadState('domcontentloaded');
          await page.waitForTimeout(4000);
          companyFollowers = await page.locator('span:has-text("followers")').first().innerText();
          console.log('Company Followers:', companyFollowers);
        } catch (e) {}
      }
      profileData.companyFollowers = companyFollowers;

      console.log('Final scraped profileData:', profileData);
      console.log('Browser will remain open for inspection. Close it manually when done.');
    } catch (err) {
      console.error('Error scraping Facebook for', person.Name || person.name, err.message);
    }
  } catch (err) {
    console.error('FATAL ERROR:', err.message);
    process.exit(1);
  }
})();
