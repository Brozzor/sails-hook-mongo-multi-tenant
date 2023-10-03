const fs = require("fs");
const MongoOperation = require("./MongoOperation");
const {getNamespace} = require("cls-hooked");

module.exports = function multitenancyHook(sails) {

  return {
    initialize: function (cb) {
      if (!fs.existsSync("api/models")) return cb();
      let modelsFiles = fs.readdirSync("api/models").filter((file) => {
        return file.split('.').pop() === "js"
      }).map((file) => {
        return file.slice(0, -3)
      });

      sails.on('hook:orm:loaded', async function () {

        sails.log.info("Transactional mode" , sails.config.transactions.enabled ? "ENABLED".green : "DISABLED".red);

        sails.tenant_db_con = {default: Tenant.getDatastore().manager}

        Object.defineProperty(sails.config, 'tenant', {
          get: function() {
            let user = getNamespace('request-session').get('user');
            return user ? user._tenant : null;
          }
        });


        for (let file of modelsFiles) {
          const modelDefinition = require("../../../api/models/" + file);
          const modelName = file.toLowerCase();
          global[file].create = (data) => {
            return new MongoOperation.CreateOperation((a, r) => {a()}, modelDefinition , modelName , data)}
          global[file].update = (cond , data) => { return new MongoOperation.UpdateOperation((a, r) => {a()}, modelDefinition , modelName , cond , data)}
          global[file].updateOne =(cond , data) => { return new MongoOperation.UpdateOneOperation((a, r) => {a()}, modelDefinition , modelName , cond , data)}
          global[file].destroy = (cond) => { return new MongoOperation.DestroyOperation((a, r) => {a()}, modelDefinition , modelName , cond)}
          global[file].destroyOne = (cond) => { return new MongoOperation.DestroyOneOperation((a, r) => {a()}, modelDefinition , modelName , cond)}
          global[file].find = (cond) => { return new MongoOperation.FindOperation((a, r) => {a()}, modelDefinition , modelName , cond)}
          global[file].findOne = (cond) => { return new MongoOperation.FindOperation((a, r) => {a()}, modelDefinition , modelName , cond , true)}
          global[file].count = (cond) => { return new MongoOperation.CountOperation((a, r) => {a()}, modelDefinition , modelName , cond)}
          sails.models[file.toLowerCase()].isMultiTenant = typeof modelDefinition.isMultiTenant !=='undefined' ? modelDefinition.isMultiTenant : true;
        }
        cb()
      })

    }
  }
}
