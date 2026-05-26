module.exports = function handler(req, res) {
  return res.status(200).json({
    ok: true,
    service: "runtime-admissibility-core",
    domain: "www.runtime-admissibility.com",
    status: "operational",
    timestamp: new Date().toISOString(),
  });
};
