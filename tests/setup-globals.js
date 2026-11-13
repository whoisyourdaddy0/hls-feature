/*
 * Test globals setup.
 *
 * The karma `sinon-chai` framework adapter in this dependency set does not
 * inject `sinon`/`chai` onto the global scope (it assumes the bundler provides
 * them), while a number of legacy `.js` unit tests reference them as bare
 * globals. Expose them explicitly here so every test can resolve them.
 */
import sinon from 'sinon';
import chai from 'chai';
import sinonChai from 'sinon-chai';

chai.use(sinonChai);

/* eslint-disable no-undef */
const globals = self;
globals.sinon = globals.sinon || sinon;
globals.chai = globals.chai || chai;
globals.expect = globals.expect || chai.expect;
globals.should = globals.should || chai.should;
