'use strict';

const methal = require('methal');
const co    = require('co');
const cache = ezpaarse.lib('cache')('hal');

/**
 * Enrich ECs with hal data
 */
module.exports = function () {
  const self         = this;
  const report       = this.report;
  const req          = this.request;
  const activated    = /^true$/i.test(req.header('hal-enrich'));
  const cacheEnabled = !/^false$/i.test(req.header('hal-cache'));

  if (!activated) { return function (ec, next) { next(); }; }

  self.logger.verbose('hal cache: %s', cacheEnabled ? 'enabled' : 'disabled');

  const ttl        = parseInt(req.header('hal-ttl')) || 3600 * 24 * 7;
  const throttle   = parseInt(req.header('hal-throttle')) || 100;
  const packetSize = parseInt(req.header('hal-paquet-size')) || 150;
  const maxAttempts = 5;
  // Minimum number of ECs to keep before resolving them
  let bufferSize   = parseInt(req.header('hal-buffer-size'));

  if (isNaN(bufferSize)) {
    bufferSize = 1000;
  }

  const buffer = [];
  let busy = false;
  let finalCallback = null;

  if (!cache) {
    const err = new Error('failed to connect to mongodb, cache not available for hal');
    err.status = 500;
    return err;
  }

  report.set('general', 'hal-queries', 0);
  report.set('general', 'hal-fails', 0);

  return new Promise(function (resolve, reject) {
    cache.checkIndexes(ttl, function (err) {
      if (err) {
        self.logger.error('hal: failed to ensure indexes' + err);
        return reject(new Error('failed to ensure indexes for the cache of hal'));
      }

      resolve(process);
    });
  });

  /**
   * enrich ec with cache or api hal
   * @param  {object} ec the EC to process, null if no EC left
   * @param  {Function} next the function to call when we are done with the given EC
   */
  function process(ec, next) {
    if (!ec) {
      finalCallback = next;
      if (!busy) {
        drainBuffer().then(() => {
          finalCallback();
        }).catch(err => {
          this.job._stop(err);
        });
      }
      return;
    }

    buffer.push([ec, next]);

    if (buffer.length > bufferSize && !busy) {
      busy = true;
      self.saturate();

      drainBuffer().then(() => {
        busy = false;
        self.drain();

        if (finalCallback) { finalCallback(); }
      }).catch(err => {
        this.job._stop(err);
      });
    }
  }

  function getPacket() {
    const packet = {
      'ecs': [],
      'identifiants': new Set(),
      'docids': new Set()
    };

    return co(function* () {

      while (packet.identifiants.size+packet.docids.size < packetSize) {
        const [ec, done] = buffer.shift() || [];
        if (!ec) { break; }

          // Reformatage de la date pour le chargement dans SolR
          ec.datetime = ec.datetime.replace("+01:00", "Z");

          // Ajout d'un paramètre booléen pour différencier les redirections
          if (ec.status == 301 || ec.status == 302 || ec.status == 304 ) {
              ec.hal_redirection = true;
          } else {
              ec.hal_redirection = false;
          }

          // Formatage pour des problèmes de comparaisons string / int
          if (ec.hal_docid) {
              ec.hal_docid = ec.hal_docid.toString();
          }

          // Modification du formatage on_campus
          if (ec.on_campus == 'N') {
            ec.on_campus = false;
          } else {
            ec.on_campus = true;
          }

          // Formatage de la collection
          if (ec.hal_collection) {
              ec.hal_collection = ec.hal_collection.toUpperCase();
          }

          // Formatage de la taille
          if (!ec.size) {
            ec.size = 0;
          }

          if (ec.mime == "PDF") {
            ec.hal_fulltext = true;
          } else {
            ec.hal_fulltext = false;
          }



        if (ec.platform !== 'hal') {
          done();
          continue;
        }

        let cachedDocument = yield checkCache(ec.hal_identifiant||ec.hal_docid);

          if (cachedDocument && cachedDocument.hal_docid) {
            // récupération des données en cache. Attention, elles doivent bien s'appeler quand elles sont mises en cache pour aller direct en sortie
            for (let prop in cachedDocument) {
              ec[prop] = cachedDocument[prop];
            }

            // @YS : il faudrait partager ce code copié/collé. J'ai peur de faire des conneries avec toutes le histoires de yield/co/etc... !
              let sid_domain;
              try {
                  sid_domain = yield getSite('PORTAIL',ec.domain,'docid');

                  if (ec.hal_collection) {
                      ec.hal_sid_collection = yield getSite('COLLECTION', ec.hal_collection,'docid');
                  }

                  if (ec.hal_redirection == true) {
                      ec.hal_sid_stop_portail = cachedDocument.hal_sid;
                      ec.hal_stop_portail = yield getSite('ID', cachedDocument.hal_sid,'url_s');
                  }
              } catch (e) {
                  return Promise.reject(e);
              }

              if (ec.hal_redirection == true && !ec.hal_collection && sid_domain == cachedDocument.hal_sid) {
                  // Il faut virer l'EC car c'est une redirection de portail à portail.
                  done(new Error());
                  continue;
              }

              if (ec.hal_redirection == true) {
                  ec.hal_sid_start_portail = sid_domain;
                  ec.hal_start_portail = ec.domain;
              } else {
                  ec.hal_sid_stop_portail = sid_domain;
                  ec.hal_stop_portail = ec.domain;
              }

              done();
              continue;
          }

          packet.ecs.push([ec, done]);

        if (ec.hal_identifiant) {
            // ON créé un paquet d'identifiants
            packet.identifiants.add(ec.hal_identifiant);
        } else if (ec.hal_docid) {
            // ON créé un paquet de docids
            packet.docids.add(ec.hal_docid);
        }
      }

      return packet;
    });
  }

  function checkCache(identifier) {
    return new Promise((resolve, reject) => {
      if (!identifier) { return resolve(); }

      cache.get(identifier, (err, cachedDocid) => {
        if (err) { return reject(err); }
        resolve(cachedDocid);
      });
    });
  }

  function drainBuffer(callback) {
    return co(function* () {

      while (buffer.length >= bufferSize || (finalCallback && buffer.length > 0)) {

        const packet = yield getPacket();

        if (packet.ecs.length === 0 || packet.identifiants.size+packet.docids.size === 0) {
          self.logger.silly('hal: no IDs in the paquet');
          yield new Promise(resolve => { setImmediate(resolve); });
          continue;
        }

        const results = new Map();
        let tries = 0;
        let docs;

        while (!docs) {
          if (++tries > maxAttempts) {
            const err = new Error(`Failed to query HAL ${maxAttempts} times in a row`);
            return Promise.reject(err);
          }

          try {
            docs = yield queryHal(Array.from(packet.identifiants), Array.from(packet.docids));

          } catch (e) {
            self.logger.error('hal: ', e.message);
          }

          yield wait();
        }

        for (const doc of docs) {

          if (!doc.halId_s || !doc.docid) { continue; }

            if (results.has(doc.halId_s)) {
                //Dans le cas où on a plusieurs fois le même identifiant avec des docids différents
                // On merge les données

                let current_doc = results.get(doc.halId_s);

                if (doc.status_i == 11) {
                    // On privilégie le docid du document en ligne (dernière version)
                    current_doc.docid = doc.docid;
                    current_doc.sid_i = doc.sid_i;
                }

                // On merge les tampons de toutes les versions du même document
                current_doc.collId_i = (current_doc.collId_i || []).concat(doc.collId_i || []);

                continue;
            }

            results.set(doc.docid.toString(), doc);
            results.set(doc.halId_s.toString(), doc);
        }

        for (let [ec, done] of packet.ecs) {

          if (results.has(ec.hal_identifiant) || results.has(ec.hal_docid)) {

              let current_doc = results.get(ec.hal_identifiant)||results.get(ec.hal_docid);
              try {
                  ec = yield getTruc(ec, current_doc);
              } catch (e) {
                  throw e;
                  return Promise.reject(e);
              }

          } else if (ec.hal_identifiant) {
              // Dans le cas où on ne trouve pas l'identifiant dans l'index, on cherche la correspondance avec l'identifiant
              let currentId = getCurrentId(ec.hal_identifiant);
              let newdoc;

              try {
                  newdoc = yield queryHal([currentId], []);
                  if (newdoc && newdoc.length > 0) {
                      newdoc = newdoc[0];

                  } else {
                      // Dans le cas où on ne trouve pas l'identifiant dans l'index, on ne sait pas à quel nouvel identifiant il peut être rattaché... c'est perdu !! Mais on le garde quand même dans la sortie
                      newdoc = null;
                  }

                  try {
                      ec = yield getTruc(ec, newdoc);
                  } catch (e) {
                      throw e;
                      return Promise.reject(e);
                  }

              } catch (e) {
                  self.logger.error('hal: ', e.message);
              }
          } else if (ec.docid) {
              // Dans le cas où on ne trouve pas le docid dans l'index, on ne sait pas à quel nouvel identifiant il peut être rattaché... c'est perdu !! Mais on le garde quand même dans la sortie
              try {
                  ec = yield getTruc(ec, null);
              } catch (e) {
                  throw e;
                  return Promise.reject(e);
              }
          }

          if (!ec) {
              // Il faut virer l'EC car c'est une redirection de portail à portail.
              done(new Error());
              continue;
          }

          done();
        }
      }
    });
  }

  function getTruc(ec, current_doc)
  {
      return co(function* () {

          // On conserve l'identifiant originel (avant fusion par exemple !) pour le cacher
          let identifiantOriginel = ec.hal_identifiant;
          let cache_doc = null;
          let sid_depot = null;

          if (current_doc) {

              ec.hal_docid = current_doc.docid;
              ec.hal_identifiant = current_doc.halId_s;
              ec.publication_title = (current_doc.title_s || [''])[0];
              ec.hal_tampons = (current_doc.collId_i || []).join(',');

              sid_depot = current_doc.sid_i;

              // Formatage du document à mettre en cache
              cache_doc = [];
              cache_doc.hal_docid = ec.hal_docid;
              cache_doc.hal_identifiant = ec.hal_identifiant;
              cache_doc.publication_title = ec.publication_title;
              cache_doc.hal_tampons = ec.hal_tampons;
              cache_doc.hal_sid = sid_depot;
          }

          let idTocache = identifiantOriginel || ec.hal_identifiant;

          try {
              if (idTocache) {
                  yield cacheResult(idTocache, cache_doc);
              }

              if (ec.hal_docid) {
                  yield cacheResult(ec.hal_docid, cache_doc);
              }
          } catch (e) {
              report.inc('general', 'hal-cache-fail');
          }

          // Cette action peut renvoyer une erreur
          let sid_domain = yield getSite('PORTAIL', ec.domain, 'docid');

          if (ec.hal_collection) {
              ec.hal_sid_collection = yield getSite('COLLECTION', ec.hal_collection, 'docid');
          }

          if (ec.hal_redirection == true && sid_depot) {
              ec.hal_stop_portail = yield getSite('ID', sid_depot, 'url_s');
              ec.hal_sid_stop_portail = sid_depot;
          }

          if (ec.hal_redirection == true && !ec.hal_collection && sid_domain == sid_depot) {
              return null;
          }

          if (ec.hal_redirection == true) {
              ec.hal_sid_start_portail = sid_domain;
              ec.hal_start_portail = ec.domain;
          } else {
              ec.hal_sid_stop_portail = sid_domain;
              ec.hal_stop_portail = ec.domain;
          }

          return ec;
      });
  }

  function wait() {
    return new Promise(resolve => { setTimeout(resolve, throttle); });
  }

  function queryHal(identifiants,docids) {
    report.inc('general', 'hal-queries');

    let search = `halId_s:(${identifiants.map(id => `${id}`).join(' OR ')})`;

    if (docids.length > 0) {
        search += ` OR docid:(${docids.map(id => `${id}`).join(' OR ')})`;
    }

    return new Promise((resolve, reject) => {
        // Attention, le paramètre rows defini le nombre de retours. Pour 1 identifiant, on peut avoir plusieurs docids. On ne peut donc pas définir rows à packetSize. Pour viser large, on multiple par 2
        // Si jamais on a plus de 2 versions de chaque document, c'est la limite. Mais c'est peu probable que ça arrive.
      methal.find('hal', search, { fields: 'docid,halId_s,title_s,collId_i,sid_i,status_i', rows:packetSize*2}, (err, docs) => {
        if (err) {
          report.inc('general', 'hal-fails');
          return reject(err);
        }

        if (!Array.isArray(docs)) {
          report.inc('general', 'hal-fails');
          return reject(new Error('invalid response'));
        }

        return resolve(docs);
      });
    });
  }

    /**
     * Pour un document fusionné, il faut récupérer son identifiant actuel
     * @param oldId
     */
    function getCurrentId(oldId) {

        let sameas = [];
        sameas["hal-01516446"] = "hal-01136517";
        sameas["hal-00549150"] = "inserm-00663565";
        sameas["hal-01566000"] = "hal-00828018";
        sameas["hal-00672052"] = "hal-00843485";
        sameas["tel-01493082"] = "tel-01542724";
        sameas["hal-00543957"] = "hal-00480657";
        sameas["lirmm-00736492"] = "hal-00706260";
        return sameas[oldId];

        /*report.inc('general', 'hal-queries');

        let search = `toto_s:${oldId}`;

        return new Promise((resolve, reject) => {
            methal.findOne('hal-same', search, { fields: 'titi_s' }, (err, doc) => {
                if (err) {
                    report.inc('general', 'hal-fails');
                    return reject(err);
            }

            return resolve(doc);
        });
    });*/
    }

    function querySiteHal(type,site, return_param) {
        report.inc('general', 'hal-queries');

        let search;

        if (type == 'ID') {
            search = `docid:${site}`;
        }else if (type == 'COLLECTION') {
            search = `site_s:${site}`;
        } else {
            search = `url_s:${site}`;
        }

        return new Promise((resolve, reject) => {
            methal.findOne('ref_site', search, { fields: return_param}, (err, doc) => {
              if (err) {
                report.inc('general', 'hal-fails');
                return reject(err);
              }


              return resolve(doc);
            });
        });
    }

    function getSite(type, sitename, return_param) {
        return co(function* () {

            // Récupération du sid ou nom dans le cache si possible
            let cachedParam = yield checkCache(sitename);
            if (cachedParam) {
                return cachedParam;
            }

            let toreturn;
            let tries = 0;

            // Récupération du sid depuis l'API de HAL
            while (!toreturn) {
                if (++tries > maxAttempts) {
                    throw new Error(`Failed to query ref_site HAL ${maxAttempts} times in a row`);
                }

                try {
                    let doc = yield querySiteHal(type, sitename, return_param);
                    if (!doc) {
                        self.logger.error("Query site Hal failed for site "+sitename+" with error : "+e.message);
                        toreturn = 0;
                    } else {
                        toreturn = doc[return_param];
                    }
                } catch (e) {
                    // La requête à l'API a planté mais on essaie maxAttempts fois avant de déclarer forfait
                    self.logger.error("Query ref_site Hal failed : "+e.message);
                }

                yield wait();
            }


            try {
                // On cache à la fois la correspondance ID=>Name et Name=>ID
                if (Array.isArray(toreturn)) {
                    toreturn = toreturn[0];
                }

                yield cacheResult(sitename, toreturn);
                yield cacheResult(toreturn, sitename);
            } catch (e) {
                report.inc('general', 'hal-cache-fail');
            }

            return toreturn;
        });
    }

  function cacheResult(id, doc) {

    return new Promise((resolve, reject) => {
      if (!id || !doc) { return resolve(); }

      cache.set(id, doc, (err, result) => {
        if (err) { return reject(err); }
        resolve(result);
      });
    });
  }

};
