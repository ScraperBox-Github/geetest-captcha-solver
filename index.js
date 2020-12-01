const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())

const Jimp = require('jimp');
const pixelmatch = require('pixelmatch');
const { cv } = require('opencv-wasm');

(async () => {
  const browser = await puppeteer.launch({
	headless: false,
	defaultViewport: null,
  });
  	const page = await browser.newPage();
	await page.goto('https://scraperbox.com/captcha/geetest');
	  
	await clickVerifyButton(page);
	
	const images = await getCaptchaImages(page);
	const diffImage = await getDiffImage(images);
	const center = await getPuzzlePieceSlotCenterPosition(diffImage);
	
	await slidePuzzlePiece(page, center);
})();

async function clickVerifyButton(page) {
	await page.waitForSelector('[aria-label="Click to verify"]');
	await page.click('[aria-label="Click to verify"]');
	await page.waitForSelector('.geetest_canvas_img canvas', {
		visible: true,
	})
	await page.waitForTimeout(1000)
}

async function getCaptchaImages(page) {
	const images = await page.$$eval(
		'.geetest_canvas_img canvas',
		(canvases) => {
			return canvases.map((canvas) => {
				// This will get the base64 image data from the 
				// html canvas. The replace function simply strip
				// the "data:image" prefix.
				return canvas
					.toDataURL()
					.replace(/^data:image\/png;base64,/, '')
			})
		}
	);

	// For each base64 string create a Javascript buffer.
	const buffers = images.map((img) => new Buffer(img, 'base64'));

	// And read each buffer into a Jimp image.
	return {
		captcha: await Jimp.read(buffers[0]),
		puzzle: await Jimp.read(buffers[1]),
		original: await Jimp.read(buffers[2]),
	};
}

async function getDiffImage(images) {
	const { width, height } = images.original.bitmap

	// Use the pixelmatch package to create an image diff
	const diffImage = new Jimp(width, height)
	pixelmatch(
		images.original.bitmap.data,
		images.captcha.bitmap.data,
		diffImage.bitmap.data,
		width,
		height,
		{ includeAA: true, threshold: 0.2 }
	)

	// Use opencv to make the diff result more clear
	const src = cv.matFromImageData(diffImage.bitmap)
	const dst = new cv.Mat()
	const kernel = cv.Mat.ones(5, 5, cv.CV_8UC1)
	const anchor = new cv.Point(-1, -1)
	cv.threshold(src, dst, 127, 255, cv.THRESH_BINARY)
	cv.erode(dst, dst, kernel, anchor, 1)
	cv.dilate(dst, dst, kernel, anchor, 1)

	return new Jimp({
		width: dst.cols,
		height: dst.rows,
		data: Buffer.from(dst.data),
	})
}

async function getPuzzlePieceSlotCenterPosition(diffImage) {
	const src = cv.matFromImageData(diffImage.bitmap)
	const dst = new cv.Mat()

	cv.cvtColor(src, src, cv.COLOR_BGR2GRAY)
	cv.threshold(src, dst, 150, 255, cv.THRESH_BINARY_INV)

	// This will find the contours of the image.
	const contours = new cv.MatVector()
	const hierarchy = new cv.Mat()
	cv.findContours(
		dst,
		contours,
		hierarchy,
		cv.RETR_EXTERNAL,
		cv.CHAIN_APPROX_SIMPLE
	)

	// Next, extract the center position from these contours.
	const contour = contours.get(0)
	const moment = cv.moments(contour)
	const cx = Math.floor(moment.m10 / moment.m00)
	const cy = Math.floor(moment.m01 / moment.m00)

	// Just for fun, let's draw the contours and center on a new image.
	cv.cvtColor(dst, dst, cv.COLOR_GRAY2BGR);
	const red = new cv.Scalar(255,0,0);
	cv.drawContours(dst, contours, 0, red);
	cv.circle(dst, new cv.Point(cx, cy), 3, red);
	new Jimp({
		width: dst.cols,
		height: dst.rows,
		data: Buffer.from(dst.data)
	}).write('./contours.png');

	return {
		x: cx,
		y: cy,
	}
}

async function slidePuzzlePiece(page, center) {
	const sliderHandle = await page.$('.geetest_slider_button')
	const handle = await sliderHandle.boundingBox()

	let handleX = handle.x + handle.width / 2;
	let handleY = handle.y + handle.height / 2;

	await page.mouse.move(handleX, handleY, { steps: 25} );
	await page.mouse.down();

	let destX = handleX + center.x;
	let destY = handle.y + handle.height / 3;
	await page.mouse.move(destX, handleY, { steps: 25 });
	await page.waitForTimeout(100)

	// find the location of my puzzle piece.
	const puzzlePos = await findMyPuzzlePiecePosition(page)
	destX = destX + center.x - puzzlePos.x;
	destY = handle.y + handle.height / 2;
	await page.mouse.move(destX, destY, { steps: 25 })
	await page.mouse.up()
}

async function findMyPuzzlePiecePosition(page) {
	// Must call the getCaptchaImages again, because we have changed the
	// slider position (and therefore the image)
	const images = await getCaptchaImages(page)
	const srcPuzzleImage = images.puzzle
	const srcPuzzle = cv.matFromImageData(srcPuzzleImage.bitmap)
	const dstPuzzle = new cv.Mat()

	cv.cvtColor(srcPuzzle, srcPuzzle, cv.COLOR_BGR2GRAY)
	cv.threshold(srcPuzzle, dstPuzzle, 127, 255, cv.THRESH_BINARY)

	const kernel = cv.Mat.ones(5, 5, cv.CV_8UC1)
	const anchor = new cv.Point(-1, -1)
	cv.dilate(dstPuzzle, dstPuzzle, kernel, anchor, 1)
	cv.erode(dstPuzzle, dstPuzzle, kernel, anchor, 1)

	const contours = new cv.MatVector()
	const hierarchy = new cv.Mat()
	cv.findContours(
		dstPuzzle,
		contours,
		hierarchy,
		cv.RETR_EXTERNAL,
		cv.CHAIN_APPROX_SIMPLE
	)

	const contour = contours.get(0)
	const moment = cv.moments(contour)

	return {
		x: Math.floor(moment.m10 / moment.m00),
		y: Math.floor(moment.m01 / moment.m00),
	}
}

