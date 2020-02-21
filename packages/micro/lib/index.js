// Native
const {Stream} = require('stream');

// Packages
const contentType = require('content-type');
const getRawBody = require('raw-body');

// based on is-stream https://github.com/sindresorhus/is-stream/blob/c918e3795ea2451b5265f331a00fb6a8aaa27816/license
function isStream(stream) {
	return stream !== null &&
	typeof stream === 'object' &&
	typeof stream.pipe === 'function';
}

function readable(stream) {
	return isStream(stream) &&
	stream.readable !== false &&
	typeof stream._read === 'function' &&
	typeof stream._readableState === 'object';
}

const {NODE_ENV} = process.env;
const DEV = NODE_ENV === 'development';

const serve = fn => (req, res) => exports.run(req, res, fn);

module.exports = serve;
exports = serve;
exports.default = serve;

const createError = (code, message, original) => {
	const err = new Error(message);

	err.statusCode = code;
	err.originalError = original;

	return err;
};

const send = (res, code, obj = null) => {
	res.statusCode = code;

	if (obj === null) {
		res.end();
		return;
	}

	if (Buffer.isBuffer(obj)) {
		if (!res.getHeader('Content-Type')) {
			res.setHeader('Content-Type', 'application/octet-stream');
		}

		res.setHeader('Content-Length', obj.length);
		res.end(obj);
		return;
	}

	if (obj instanceof Stream || readable(obj)) {
		if (!res.getHeader('Content-Type')) {
			res.setHeader('Content-Type', 'application/octet-stream');
		}

		obj.pipe(res);
		return;
	}

	let str = obj;

	if (typeof obj === 'object' || typeof obj === 'number') {
		// We stringify before setting the header
		// in case `JSON.stringify` throws and a
		// 500 has to be sent instead

		// the `JSON.stringify` call is split into
		// two cases as `JSON.stringify` is optimized
		// in V8 if called with only one argument
		if (DEV) {
			str = JSON.stringify(obj, null, 2);
		} else {
			str = JSON.stringify(obj);
		}

		if (!res.getHeader('Content-Type')) {
			res.setHeader('Content-Type', 'application/json; charset=utf-8');
		}
	}

	res.setHeader('Content-Length', Buffer.byteLength(str));
	res.end(str);
};

const sendError = (req, res, errorObj) => {
	const statusCode = errorObj.statusCode || errorObj.status;
	const message = statusCode ? errorObj.message : 'Internal Server Error';
	send(res, statusCode || 500, DEV ? errorObj.stack : message);
	if (errorObj instanceof Error) {
		console.error(errorObj.stack);
	} else {
		console.warn('thrown error must be an instance Error');
	}
};

exports.send = send;
exports.sendError = sendError;
exports.createError = createError;

const parseJSON = str => {
	try {
		return JSON.parse(str);
	} catch (err) {
		throw createError(400, 'Invalid JSON', err);
	}
};

// Maps requests to buffered raw bodies so that
// multiple calls to `json` work as expected
const rawBodyMap = new WeakMap();

exports.run = (req, res, fn) => {
	const clearRawBodyMap = () => rawBodyMap.delete(req);
	res.on('finish', clearRawBodyMap);
	res.on('close', clearRawBodyMap);

	return Promise.resolve(fn(req, res)).then(val => {
		if (val === null) {
			send(res, 204, null);
			return;
		}

		// Send value if it is not undefined, otherwise assume res.end
		// will be called later
		// eslint-disable-next-line no-undefined
		if (val !== undefined) {
			send(res, res.statusCode || 200, val);
		}
	})
		.catch(err => sendError(req, res, err));
};

exports.buffer = (req, {limit = '1mb', encoding, parse = a => a} = {}) => (
	new Promise((resolve, reject) => {
		const body = rawBodyMap.get(req);
		if (body) {
			resolve(parse(body));
			return;
		}

		const type = req.headers['content-type'] || 'text/plain';
		const length = req.headers['content-length'];

		// eslint-disable-next-line no-undefined
		if (encoding === undefined) {
			encoding = contentType.parse(type).parameters.charset;
		}

		getRawBody(req, {limit, length, encoding}, (err, buf) => {
			if (err) {
				let reason;
				if (err.type === 'entity.too.large') {
					reason = createError(413, `Body exceeded ${limit} limit`, err);
				} else {
					reason = createError(400, 'Invalid body', err);
				}
				reject(reason);
				return;
			}
			rawBodyMap.set(req, buf);
			return parse(buf);
		});
	})
);

exports.text = (req, {limit, encoding} = {}) =>
	exports.buffer(req, {limit, encoding, parse: body => body.toString(encoding)});

exports.json = (req, {limit, encoding} = {}) =>
	exports.text(req, {limit, encoding, parseJSON});
