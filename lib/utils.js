import 'dotenv/config';
import chalk from 'chalk';
import moment from 'moment-timezone';

moment.tz.setDefault('Asia/Jakarta').locale('id');

/**
 * Get text with color
 * @param {string} text
 * @param {string} [color]
 * @returns {string}
 */
const color = (text, color) => {
    return !color ? chalk.green(text) : chalk.keyword(color)(text);
};

/**
 * Get time duration in seconds since message timestamp
 * @param {number} timestamp
 * @param {Date} now
 * @returns {number}
 */
const processTime = (timestamp, now) => {
    return moment.duration(now - moment(timestamp * 1000)).asSeconds();
};

/**
 * Check if string is a URL
 * @param {string} url
 * @returns {RegExpMatchArray|null}
 */
const isUrl = (url) => {
    return url.match(
        new RegExp(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,50}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi)
    );
};

// --- Message Cooldown / Spam Filter ---
const usedCommandRecently = new Set();

const isFiltered = (from) => !!usedCommandRecently.has(from);

const addFilter = (from, delay = 5000) => {
    usedCommandRecently.add(from);
    setTimeout(() => usedCommandRecently.delete(from), delay);
};

const addFilter2 = (from, delay = 10000) => {
    usedCommandRecently.add(from);
    setTimeout(() => usedCommandRecently.delete(from), delay);
};

export const msgFilter = { isFiltered, addFilter, addFilter2 };
export { processTime, isUrl, color };
export default { msgFilter, processTime, isUrl, color };
