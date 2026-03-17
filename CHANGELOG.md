# [1.5.0](https://github.com/jkrumm/rollhook-action/compare/v1.4.5...v1.5.0) (2026-03-17)


### Features

* **deploy:** support pre-built image_tag for external registries ([8e62ea2](https://github.com/jkrumm/rollhook-action/commit/8e62ea215f573b0dc06e8a1777887f00ca6a6b2f))

## [1.4.5](https://github.com/jkrumm/rollhook-action/compare/v1.4.4...v1.4.5) (2026-03-17)


### Bug Fixes

* **push:** remove invalid --jobs flag from crane push ([df71f7d](https://github.com/jkrumm/rollhook-action/commit/df71f7d510d94bc3c3a05be3a53990ee6fdcff2d))

## [1.4.4](https://github.com/jkrumm/rollhook-action/compare/v1.4.3...v1.4.4) (2026-03-17)


### Bug Fixes

* **push:** use crane with serialized uploads ([5217c84](https://github.com/jkrumm/rollhook-action/commit/5217c848634d652b6ed0921dea04231c1d5516e3))

## [1.4.3](https://github.com/jkrumm/rollhook-action/compare/v1.4.2...v1.4.3) (2026-03-17)


### Bug Fixes

* **push:** retry entire skopeo copy on Cloudflare 520 ([85e9ba3](https://github.com/jkrumm/rollhook-action/commit/85e9ba38c7235dfc8075a664d861097f577f5601))

## [1.4.2](https://github.com/jkrumm/rollhook-action/compare/v1.4.1...v1.4.2) (2026-03-17)


### Bug Fixes

* **push:** add retry and remove unnecessary TLS skip ([9ad2cbc](https://github.com/jkrumm/rollhook-action/commit/9ad2cbcfac856a104e3ecc03ee34a16ff9c2d533))

## [1.4.1](https://github.com/jkrumm/rollhook-action/compare/v1.4.0...v1.4.1) (2026-03-17)


### Bug Fixes

* **push:** replace docker push with skopeo ([2ba4558](https://github.com/jkrumm/rollhook-action/commit/2ba4558f77164bcd9844ddf4c421851000cb67aa))

# [1.4.0](https://github.com/jkrumm/rollhook-action/compare/v1.3.0...v1.4.0) (2026-03-17)


### Features

* **push:** retry docker push up to 3 times with exponential backoff ([4920972](https://github.com/jkrumm/rollhook-action/commit/4920972268787c1abb6e230d492b553eaeba75dc))

# [1.3.0](https://github.com/jkrumm/rollhook-action/compare/v1.2.0...v1.3.0) (2026-03-17)


### Features

* **action:** zero-secret build+push+deploy via OIDC ([63fb398](https://github.com/jkrumm/rollhook-action/commit/63fb3985b51db8a5333c15cd9a9b0aef6a3533b4))

# [1.2.0](https://github.com/jkrumm/rollhook-action/compare/v1.1.0...v1.2.0) (2026-03-16)


### Features

* **auth:** replace token input with GitHub Actions OIDC ([cd19c52](https://github.com/jkrumm/rollhook-action/commit/cd19c52d9d39d80f8f6005c5795704a3002aeee4))
* **runtime:** upgrade to Node.js 24 ([44209d0](https://github.com/jkrumm/rollhook-action/commit/44209d0f907f439137df886eaaa55ae237a0f49f))

# [1.1.0](https://github.com/jkrumm/rollhook-action/compare/v1.0.3...v1.1.0) (2026-02-28)


### Features

* derive app from image_tag, remove app input ([9667015](https://github.com/jkrumm/rollhook-action/commit/966701572441eeb3013c423c22161303be7ccf07))

## [1.0.3](https://github.com/jkrumm/rollhook-action/compare/v1.0.2...v1.0.3) (2026-02-28)


### Bug Fixes

* **url:** normalize base URL — strip path, add https:// if missing ([de4beb5](https://github.com/jkrumm/rollhook-action/commit/de4beb57752b28728d8cbb6f29bc7b24542c3c85))

## [1.0.2](https://github.com/jkrumm/rollhook-action/compare/v1.0.1...v1.0.2) (2026-02-28)


### Bug Fixes

* add admin_token input for job polling and log streaming ([50f0c19](https://github.com/jkrumm/rollhook-action/commit/50f0c19b9c8b25d5928430407ad3b86bce41e68b))

## [1.0.1](https://github.com/jkrumm/rollhook-action/compare/v1.0.0...v1.0.1) (2026-02-28)


### Bug Fixes

* **ci:** use node 22 for semantic-release (requires ^22.14.0) ([610eb0e](https://github.com/jkrumm/rollhook-action/commit/610eb0ecc56bb7b7c4fbb95a50fe29743b03936f))
